import http from 'node:http';
import path from 'node:path';
import { CLIError } from '../helpers/index.js';
import { runAdbReverse } from './common/runAdbReverse.js';
import {
  assertRemoteStandalone,
  ConfigFileInvalidError,
  FEDERATION_CONFIG_FILENAME,
  loadFederationConfig,
} from './federation/configFile.js';
import type { PlanInput, PlannedApp } from './federation/devPlan.js';
import { buildPlan } from './federation/devPlan.js';
import { isPortBusy, planPorts } from './federation/portPlanner.js';
import { resolveReactNativeBin } from './federation/rnBin.js';
import { RunnerConsole } from './federation/runnerConsole.js';
import {
  planToJson,
  renderPlanTable,
  renderStatusTable,
  statusToJson,
} from './federation/statusTable.js';
import { DevSupervisor } from './federation/supervisor.js';
import type { CliConfig, FederationDevArguments } from './types.js';

/**
 * Readiness/TOCTOU probe: `GET url/status` answers with its body, anything
 * else (refused, timeout, non-200) is silence — never a thrown error, the
 * supervisor treats both as "not up".
 */
function probeStatus(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const request = http.get(`${url}/status`, { timeout: 1000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve(response.statusCode === 200 ? body : null)
      );
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
  });
}

/** Split `--apps` into names, tolerating a merged array from the CLI. */
function parseAppList(apps: string | string[] | undefined): string[] {
  if (!apps) return [];
  const values = Array.isArray(apps) ? apps : [apps];
  return values.flatMap((value) =>
    value
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  );
}

/** Usage error: actionable message, exit 2, nothing spawned. */
function usageError(message: string): void {
  console.error(message);
  process.exit(2);
}

function printPlan(plan: PlannedApp[], json: boolean): void {
  if (json) {
    console.log(planToJson(plan));
    return;
  }
  for (const row of renderPlanTable(plan)) console.log(row);
}

/**
 * Run every app a `repack-federation.json` declares — host plus a session of
 * remotes — as one supervised dev session. Exit codes: 0 success or dry-run
 * plan, 1 port conflict / failed session, 2 usage or config error (nothing
 * spawned). `--dry-run` prints the plan and spawns nothing.
 *
 * @param _argv Original, non-parsed arguments.
 * @param _cliConfig Configuration object containing platform and project settings.
 * @param args Parsed command line arguments.
 */
export async function federationDev(
  _argv: string[],
  _cliConfig: CliConfig,
  args: FederationDevArguments
) {
  if (
    args.port !== undefined &&
    (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535)
  ) {
    usageError(
      `Invalid --port ${args.port}: expected an integer between 1 and 65535.`
    );
    return;
  }
  if (
    args.platform !== undefined &&
    args.platform !== 'ios' &&
    args.platform !== 'android'
  ) {
    usageError(
      `Invalid --platform "${args.platform}": only "ios" and "android" are ` +
        'supported — the runner starts one dev server session per platform.'
    );
    return;
  }

  let loaded: ReturnType<typeof loadFederationConfig>;
  try {
    loaded = loadFederationConfig();
  } catch (error) {
    if (error instanceof ConfigFileInvalidError) {
      usageError(`${error.filePath}: ${error.reasons.join('; ')}`);
      return;
    }
    throw error;
  }
  if (!loaded) {
    usageError(
      `No ${FEDERATION_CONFIG_FILENAME} found — federation-dev runs the apps ` +
        'that file declares. Create one with "react-native federation-init".'
    );
    return;
  }
  const { filePath, config } = loaded;

  const declaredNames = Object.keys(config.remotes);
  const requested = parseAppList(args.apps);
  const unknown = requested.filter((name) => !(name in config.remotes));
  if (unknown.length > 0) {
    usageError(
      `Unknown app ${unknown.map((name) => JSON.stringify(name)).join(', ')} — ` +
        `not a declared remote in ${filePath}. Known remotes: ` +
        (declaredNames.join(', ') || '(none)') +
        '.'
    );
    return;
  }
  if (args.standalone !== undefined && !(args.standalone in config.remotes)) {
    usageError(
      `Unknown app ${JSON.stringify(args.standalone)} — not a declared ` +
        `remote in ${filePath}. Known remotes: ` +
        (declaredNames.join(', ') || '(none)') +
        '.'
    );
    return;
  }

  // Standalone refuses through the shipped gate, before any planning.
  if (args.standalone !== undefined) {
    try {
      assertRemoteStandalone(config, filePath, args.standalone);
    } catch (error) {
      if (error instanceof CLIError) {
        usageError(error.message);
        return;
      }
      throw error;
    }
  }

  // Wizard gate: --apps, --no-interactive or a non-TTY stdout suppress the
  // interactive wizard; the default session is then host + every remote.
  const session: PlanInput['session'] = {
    remotes: requested.length > 0 ? requested : declaredNames,
    standaloneRemote: args.standalone,
  };

  const configDir = path.dirname(filePath);
  const hostRoot = path.resolve(configDir, config.host.root ?? '.');
  let rnCliPath: string;
  try {
    rnCliPath = resolveReactNativeBin(hostRoot, { extraPaths: [configDir] });
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
    return;
  }

  const planBase = {
    configPath: filePath,
    config,
    session,
    overrides: {
      port: args.port,
      platform: args.platform === 'android' ? 'android' : args.platform,
    },
    rnCliPath,
  } as const;

  let effective: PlannedApp[];
  try {
    effective = buildPlan({ ...planBase, ports: {} });
  } catch (error) {
    if (error instanceof CLIError) {
      usageError(error.message);
      return;
    }
    throw error;
  }

  const conflicts: { app: string; port: number }[] = [];
  let ports: Record<string, number | 'auto'>;

  if (args.dryRun) {
    // Conflict rules run read-only against the real machine: a busy declared
    // port fails the same way a live run would — but nothing is allocated or
    // spawned, and unmanaged apps display `auto`.
    ports = {};
    for (const app of effective) {
      if (app.port === undefined) {
        ports[app.name] = 'auto';
      } else if (await isPortBusy(app.port)) {
        if (args.autoPorts) ports[app.name] = 'auto';
        else conflicts.push({ app: app.name, port: app.port });
      } else {
        ports[app.name] = app.port;
      }
    }
  } else {
    const resolved = await planPorts(effective, {
      autoPorts: args.autoPorts === true,
      probePort: isPortBusy,
    });
    conflicts.push(...resolved.conflicts);
    ports = resolved.ports;
  }

  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      console.error(
        `Port ${conflict.port} declared by ${conflict.app} is already in ` +
          'use. Free the port or rerun with --auto-ports.'
      );
    }
    process.exit(1);
    return;
  }

  const plan = buildPlan({ ...planBase, ports });
  printPlan(plan, args.json === true);

  if (args.dryRun) {
    process.exit(0);
    return;
  }

  // Live session. adb: the host port goes through the audited
  // `runAdbReverse` helper exactly once (device discovery lives inside it);
  // remote ports are printed guidance only — the runner never executes adb
  // for them (threat row "adb execution").
  const host = plan.find((app) => app.role === 'host')!;
  const runnerConsole = new RunnerConsole({ stdout: process.stdout });
  const platform = args.platform ?? 'ios';
  await runAdbReverse({ port: host.port as number });
  for (const app of plan) {
    if (app.role === 'remote') {
      console.log(
        `Remote port: run "adb reverse tcp:${app.port} tcp:${app.port}" on ` +
          'your device to reach it from the app.'
      );
    }
  }
  console.log(
    `Run your app with: react-native run-${platform} — it reaches the host ` +
      `dev server at ${host.url}`
  );

  const supervisor = new DevSupervisor(plan, runnerConsole, { probeStatus });
  // One Ctrl-C asks for the supervisor's ordered shutdown; the second one
  // escalates inside the supervisor (SIGINT → grace → SIGTERM).
  const onSigint = () => supervisor.shutdown('interrupt');
  process.on('SIGINT', onSigint);

  let lastDoc = '';
  const statusWatch = setInterval(() => {
    if (!args.json) return;
    const doc = statusToJson(plan, supervisor.getStatuses());
    if (doc !== lastDoc) {
      lastDoc = doc;
      console.log(doc);
    }
  }, 250);

  const result = await supervisor.run();
  clearInterval(statusWatch);
  process.off('SIGINT', onSigint);

  const statuses = supervisor.getStatuses();
  if (args.json) {
    console.log(statusToJson(plan, statuses));
  } else {
    const rows = renderStatusTable(plan, statuses);
    for (const row of rows) console.log(row);
    runnerConsole.persist(rows);
  }
  runnerConsole.release();
  process.exit(result.exitCode);
}

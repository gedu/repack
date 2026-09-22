import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import execa from 'execa';
import { runAdbReverse } from '../common/runAdbReverse.js';
import * as portPlanner from '../federation/portPlanner.js';
import { federationDev } from '../federation-dev.js';

jest.mock('execa');
const execaMock = execa as unknown as jest.Mock;

jest.mock('../common/runAdbReverse.js');
const adbMock = runAdbReverse as jest.Mock;

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = jest.fn();
}

const FIXTURES = path.join(
  __dirname,
  '..',
  'federation',
  '__tests__',
  '__fixtures__'
);
const TWIN = path.join(FIXTURES, 'config-dev-twin');

const cliConfig = {
  root: '/project',
  platforms: ['ios'],
  reactNativePath: '/project/node_modules/react-native',
};

let exitSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let tmpDir: string;
let previousCwd: string;

const output = () =>
  [...logSpy.mock.calls, ...errorSpy.mock.calls]
    .map((call) => call.map(String).join(' '))
    .join('\n');

beforeEach(() => {
  previousCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fed-dev-'));
  exitSpy = jest
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  // Deterministic probes: the developer's machine may really hold 8081/8082.
  jest.spyOn(portPlanner, 'isPortBusy').mockResolvedValue(false);
  process.chdir(TWIN);
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('federation-dev usage errors (exit 2, spawn nothing)', () => {
  it('missing workspace file names repack-federation.json and federation-init', async () => {
    process.chdir(tmpDir);
    await federationDev([], cliConfig, {
      apps: 'MiniApp',
      interactive: false,
    });
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(output()).toContain('repack-federation.json');
    expect(output()).toContain('federation-init');
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('invalid file names the path and the failing field, no stack', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'repack-federation.json'),
      JSON.stringify({ host: { root: '.' }, remotes: {} })
    );
    process.chdir(tmpDir);
    await federationDev([], cliConfig, { interactive: false });
    expect(exitSpy).toHaveBeenCalledWith(2);
    const text = output();
    expect(text).toContain(path.join(tmpDir, 'repack-federation.json'));
    expect(text).toContain('host.manifest');
    expect(text).not.toMatch(/\n\s+at\s/);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('unknown --apps name is named and known remotes are listed', async () => {
    await federationDev([], cliConfig, {
      apps: 'NoSuchApp',
      interactive: false,
    });
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(output()).toContain('NoSuchApp');
    // Lists the known remote so the user sees the typo's alternative.
    expect(output()).toContain('MiniApp');
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('a flag-shaped --apps value is an unknown name, not an option', async () => {
    // Threat row "Subprocess spawn": `--apps --no-interactive` never reaches
    // any spawn argv — it is rejected as an unknown app name.
    await federationDev([], cliConfig, {
      apps: '--no-interactive',
      interactive: false,
    });
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(output()).toContain('--no-interactive');
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('--platform web exits 2 naming ios and android', async () => {
    await federationDev([], cliConfig, {
      platform: 'web',
      interactive: false,
    });
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(output()).toContain('ios');
    expect(output()).toContain('android');
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('a non-integer --port exits 2', async () => {
    await federationDev([], cliConfig, {
      port: Number('abc'),
      interactive: false,
    });
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('standalone on an undeclared remote exits 2 naming the remote and the field', async () => {
    process.chdir(path.join(FIXTURES, 'config-standalone'));
    await federationDev([], cliConfig, {
      standalone: 'undeclared',
      interactive: false,
    });
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(output()).toContain('undeclared');
    expect(output()).toContain('standalone');
    expect(execaMock).not.toHaveBeenCalled();
  });
});

describe('federation-dev non-TTY defaults', () => {
  it('defaults the plan to host plus every declared remote without prompting', async () => {
    // jest's stdout is not a TTY: the wizard never runs; the default
    // session is host + all remotes (spec "Non-TTY default plan").
    await federationDev([], cliConfig, { dryRun: true });
    expect(exitSpy).toHaveBeenCalledWith(0);
    const text = output();
    expect(text).toContain('host');
    expect(text).toContain('MiniApp');
    expect(execaMock).not.toHaveBeenCalled();
  });
});

describe('federation-dev live session', () => {
  let children: FakeChild[];
  let servers: http.Server[];
  let liveWorkspace: string;

  // OS-assigned free port when 0; resolves with the port actually bound.
  const startServer = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        // The readiness contract real dev servers answer on /status.
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('packager-status:running');
      });
      server.once('error', reject);
      server.listen(port, () => {
        servers.push(server);
        resolve((server.address() as { port: number }).port);
      });
    });

  const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 8000,
    describeState: () => string = () => ''
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error(`waitFor timed out: ${describeState()}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  beforeEach(() => {
    children = [];
    servers = [];
    liveWorkspace = '';
    execaMock.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
  });

  afterEach(async () => {
    for (const child of children) child.emit('exit', 0, null);
    if (liveWorkspace)
      fs.rmSync(liveWorkspace, { recursive: true, force: true });
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            // Readiness pollers keep a socket pool warm; force-kill the
            // keep-alive handles so close() cannot hang the suite.
            server.closeAllConnections?.();
          })
      )
    );
  });

  it('spawns host + selected remote with the requested port, prints adb guidance, never runs adb itself', async () => {
    // No servers needed: the assertions cover spawn argv and guidance, and
    // a clean exit-0 ends the session whatever the readiness state.
    const command = federationDev([], cliConfig, {
      apps: 'MiniApp',
      platform: 'ios',
      port: 8090,
      interactive: false,
    });
    await waitFor(() => execaMock.mock.calls.length === 2);

    const spawnArgs = execaMock.mock.calls.map(
      (call) => (call as unknown as [string, string[]])[1]
    );
    expect(spawnArgs).toHaveLength(2);
    const hostArgs = spawnArgs.find((a) => a.includes('8090'));
    const remoteArgs = spawnArgs.find((a) => a.includes('8082'));
    expect(hostArgs).toBeDefined();
    expect(remoteArgs).toBeDefined();
    for (const args of spawnArgs) {
      expect(args).toContain('--no-interactive');
      // Threat row "adb execution": no adb ever rides the spawn mock.
      expect(args.join(' ')).not.toContain('adb');
    }
    // Host port goes through the audited runAdbReverse helper, once.
    expect(adbMock).toHaveBeenCalledTimes(1);
    expect(adbMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 8090 })
    );
    // Remote port is guidance for the developer, not an executed command.
    expect(output()).toContain('adb reverse tcp:8082 tcp:8082');
    // Platform guidance names the runnable command and the host port.
    expect(output()).toContain('run-ios');
    expect(output()).toContain('8090');

    for (const child of children) child.emit('exit', 0, null);
    await command;
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  }, 20000);

  it('--json live emits a parseable plan doc and status docs ending exited', async () => {
    // OS-assigned ports inside a workspace under the fixtures tree (so the
    // repo's react-native stays resolvable): well-known 8081/8082 may be
    // held by real dev servers on the developer's machine.
    const hostPort = await startServer(0);
    const remotePort = await startServer(0);
    liveWorkspace = fs.mkdtempSync(path.join(FIXTURES, 'live-'));
    fs.writeFileSync(
      path.join(liveWorkspace, 'repack-federation.json'),
      JSON.stringify({
        host: { manifest: './build/host', root: '.', port: hostPort },
        remotes: {
          MiniApp: { manifest: './build/mini', root: '.', port: remotePort },
        },
      })
    );
    process.chdir(liveWorkspace);

    const command = federationDev([], cliConfig, {
      apps: 'MiniApp',
      json: true,
      interactive: false,
    });
    await waitFor(() => execaMock.mock.calls.length === 2);
    const docsUpToRunning = () =>
      logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
    await waitFor(
      () => {
        const docs = docsUpToRunning().filter((d) => d.event === 'status');
        return (
          docs.length > 0 &&
          docs[docs.length - 1].apps.every(
            (app: { status: string }) => app.status === 'running'
          )
        );
      },
      12000,
      () =>
        JSON.stringify({
          spawnCalls: execaMock.mock.calls.length,
          children: children.length,
          docs: docsUpToRunning().map((doc) => doc.event),
        })
    );
    for (const child of children) child.emit('exit', 0, null);
    await command;

    const docs = docsUpToRunning();
    expect(docs[0].event).toBe('plan');
    const finalDoc = docs[docs.length - 1];
    expect(finalDoc.event).toBe('status');
    expect(finalDoc.apps.map((app: { status: string }) => app.status)).toEqual([
      'exited',
      'exited',
    ]);
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  }, 20000);

  it('exits 1 naming app and busy port without spawning or hanging', async () => {
    jest
      .spyOn(portPlanner, 'isPortBusy')
      .mockImplementation(async (port: number) => port === 8082);
    const command = federationDev([], cliConfig, {
      apps: 'MiniApp',
      interactive: false,
    });
    await expect(command).resolves.toBeUndefined();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(output()).toContain('MiniApp');
    expect(output()).toContain('8082');
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('--dry-run --json is byte-identical across runs and spawns nothing', async () => {
    await federationDev([], cliConfig, { dryRun: true, json: true });
    const firstRun = logSpy.mock.calls.map((call) => String(call[0]));
    logSpy.mockClear();
    await federationDev([], cliConfig, { dryRun: true, json: true });
    const secondRun = logSpy.mock.calls.map((call) => String(call[0]));
    expect(secondRun).toEqual(firstRun);
    expect(JSON.parse(firstRun[0]!).event).toBe('plan');
    expect(execaMock).not.toHaveBeenCalled();
  });
});

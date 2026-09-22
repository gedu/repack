import nodeReadline from 'node:readline';
import type { FederationConfig } from './configFile.js';
import type { PlannedApp } from './devPlan.js';

/** What the wizard collects — plain planning inputs, nothing else. */
export interface WizardAnswers {
  session: { remotes: string[]; standaloneRemote?: string };
  /** Absent means "all": no per-platform spawn arg or guidance. */
  platform?: 'ios' | 'android';
  /** Per-app port as confirmed or overridden, keyed by app name. */
  ports: Record<string, number>;
}

export type WizardOutcome =
  | { status: 'completed'; answers: WizardAnswers }
  | { status: 'cancelled' };

/** The slice of `@clack/prompts` the wizard uses, injectable for tests. */
interface ClackLike {
  multiselect(options: {
    message: string;
    hint?: string;
    options: Array<{ value: string; label: string }>;
    initialValue?: string[];
    maxItems?: number;
    required?: boolean;
  }): Promise<unknown>;
  select(options: {
    message: string;
    hint?: string;
    options: Array<{ value: string; label: string }>;
  }): Promise<unknown>;
  confirm(options: {
    message: string;
    hint?: string;
    initialValue?: boolean;
  }): Promise<unknown>;
  text(options: {
    message: string;
    hint?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<unknown>;
  cancel(message: string): void;
  isCancel(value: unknown): boolean;
}

/**
 * Key legends per step kind. Clack 0.9.1 has no prompt-level `hint` option
 * (its `hint` is per-option and renders inline next to choices), so the
 * legend is embedded as a second line of the `message` — the one block clack
 * renders verbatim from the very first frame, before any key press. The
 * `hint` field travels alongside for tests and any future clack that grows
 * a native prompt-level hint.
 */
const HINTS = {
  multiselect: '↑↓ move · space toggle · a toggle all · enter confirm',
  select: '↑↓ move · enter confirm',
  confirm: '←/→ choose · enter confirm',
  port: 'type a port · enter to accept',
} as const;

/** Message plus its legend line, visible on the first render. */
function legended(message: string, hint: string) {
  return { message: `${message}\n${hint}`, hint };
}

async function loadClackDefault(): Promise<ClackLike> {
  return (await import('@clack/prompts')) as unknown as ClackLike;
}

function portListAnswer(answer: string, declared: string[]): string[] {
  const trimmed = answer.trim();
  if (trimmed === '') return declared;
  return trimmed
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

const validatePort = (value: string): string | undefined => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return 'Enter an integer port between 1 and 65535.';
  }
  return undefined;
};

async function runClackWizard(
  clack: ClackLike,
  config: FederationConfig,
  planned: PlannedApp[]
): Promise<WizardOutcome> {
  const cancelled: WizardOutcome = { status: 'cancelled' };
  const declaredRemotes = Object.keys(config.remotes);

  const selected = await clack.multiselect({
    ...legended('Which remotes to run?', HINTS.multiselect),
    options: declaredRemotes.map((name) => ({ value: name, label: name })),
    initialValue: declaredRemotes,
    maxItems: 8,
    required: false,
  });
  if (clack.isCancel(selected)) {
    clack.cancel('Session cancelled.');
    return cancelled;
  }
  const remotes = selected as string[];

  const platformAnswer = await clack.select({
    ...legended('Which app platform are you running?', HINTS.select),
    options: [
      { value: 'ios', label: 'iOS' },
      { value: 'android', label: 'Android' },
      { value: 'all', label: 'All / decide later' },
    ],
  });
  if (clack.isCancel(platformAnswer)) {
    clack.cancel('Session cancelled.');
    return cancelled;
  }
  const platform =
    platformAnswer === 'ios' || platformAnswer === 'android'
      ? platformAnswer
      : undefined;

  const ports: Record<string, number> = {};
  for (const app of planned) {
    if (app.role === 'remote' && !remotes.includes(app.name)) continue;
    const keep = await clack.confirm({
      ...legended(`Use port ${app.port} for ${app.name}?`, HINTS.port),
      initialValue: true,
    });
    if (clack.isCancel(keep)) {
      clack.cancel('Session cancelled.');
      return cancelled;
    }
    if (keep === true) {
      ports[app.name] = app.port as number;
      continue;
    }
    const override = await clack.text({
      ...legended(`Port for ${app.name}:`, HINTS.port),
      validate: validatePort,
    });
    if (clack.isCancel(override)) {
      clack.cancel('Session cancelled.');
      return cancelled;
    }
    ports[app.name] = Number(override);
  }

  // Standalone is only ever offered for selected remotes that declare it —
  // the file stays the single source of the capability (spec scenario).
  let standaloneRemote: string | undefined;
  for (const name of remotes) {
    if (config.remotes[name]?.standalone !== true) continue;
    const runStandalone = await clack.confirm({
      ...legended(`Run ${name} in standalone mode?`, HINTS.confirm),
      initialValue: false,
    });
    if (clack.isCancel(runStandalone)) {
      clack.cancel('Session cancelled.');
      return cancelled;
    }
    if (runStandalone === true) {
      standaloneRemote = name;
      break;
    }
  }

  return {
    status: 'completed',
    answers: {
      session: standaloneRemote ? { remotes, standaloneRemote } : { remotes },
      platform,
      ports,
    },
  };
}

/**
 * Line reader that BUFFERS answers arriving while no question is pending —
 * `readline/promises.question()` drops exactly those lines, which hangs the
 * next question on any piped input (all answers arrive in one chunk). EOF
 * makes every further question reject, which the wizard maps to cancel.
 */
function createLineReader(
  stream: NodeJS.ReadableStream,
  out: NodeJS.WritableStream
) {
  const rl = nodeReadline.createInterface({
    input: stream as NodeJS.ReadStream,
    output: out as NodeJS.WriteStream,
    terminal: Boolean((stream as { isTTY?: boolean }).isTTY),
  });
  const buffered: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let ended = false;
  rl.on('line', (line) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(line);
    } else {
      buffered.push(line);
    }
  });
  rl.on('close', () => {
    ended = true;
    waiter?.(null);
    waiter = null;
  });
  const closedStream = new Error('stdin closed while the wizard was asking');
  return {
    async question(prompt: string): Promise<string> {
      out.write(prompt);
      if (buffered.length > 0) return buffered.shift() as string;
      if (ended) throw closedStream;
      const line = await new Promise<string | null>((resolve) => {
        waiter = resolve;
      });
      if (line === null) throw closedStream;
      return line;
    },
    close() {
      rl.close();
    },
  };
}

async function runReadlineWizard(
  config: FederationConfig,
  planned: PlannedApp[],
  streams: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }
): Promise<WizardOutcome> {
  const rl = createLineReader(
    streams.input ?? process.stdin,
    streams.output ?? process.stdout
  );
  const cancelled: WizardOutcome = { status: 'cancelled' };
  try {
    const declaredRemotes = Object.keys(config.remotes);
    const remotes = portListAnswer(
      await rl.question(
        `Remotes to run (comma-separated, empty = all: ${declaredRemotes.join(', ')})` +
          ` — type names · enter to accept: `
      ),
      declaredRemotes
    );
    const platformAnswer = (
      await rl.question(
        'Platform (ios/android, empty = all) — type ios/android · enter to accept: '
      )
    )
      .trim()
      .toLowerCase();
    const platform =
      platformAnswer === 'ios' || platformAnswer === 'android'
        ? platformAnswer
        : undefined;

    const ports: Record<string, number> = {};
    for (const app of planned) {
      if (app.role === 'remote' && !remotes.includes(app.name)) continue;
      let answer = (
        await rl.question(
          `Port for ${app.name} [${app.port}] — type a port · enter to accept: `
        )
      )
        .trim()
        .toLowerCase();
      while (answer !== '' && validatePort(answer)) {
        answer = (
          await rl.question(
            `Port for ${app.name} [${app.port}] (integer 1-65535, empty = default)` +
              ` — type a port · enter to accept: `
          )
        )
          .trim()
          .toLowerCase();
      }
      ports[app.name] = answer === '' ? (app.port as number) : Number(answer);
    }

    let standaloneRemote: string | undefined;
    for (const name of remotes) {
      if (config.remotes[name]?.standalone !== true) continue;
      const answer = (
        await rl.question(
          `Run ${name} in standalone mode? (y/N) — type y/n · enter to accept: `
        )
      )
        .trim()
        .toLowerCase();
      if (answer === 'y' || answer === 'yes') {
        standaloneRemote = name;
        break;
      }
    }

    return {
      status: 'completed',
      answers: {
        session: standaloneRemote ? { remotes, standaloneRemote } : { remotes },
        platform,
        ports,
      },
    };
  } catch {
    // readline/promises rejects when stdin closes mid-question: the user
    // walked away — the same outcome as cancelling in the clack wizard.
    return cancelled;
  } finally {
    rl.close();
  }
}

/**
 * Collect session inputs on an interactive terminal: remotes → platform →
 * ports → standalone. An input source only — the answers feed the same
 * `buildPlan` the flags drive, never a second execution path. Falls back to
 * sequential readline prompts when clack cannot be loaded; the caller keeps
 * the non-TTY case away from this function entirely.
 */
export async function runWizard(input: {
  config: FederationConfig;
  /** First-pass plan: its per-app ports are the wizard's defaults. */
  planned: PlannedApp[];
  loadClack?: () => Promise<ClackLike>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<WizardOutcome> {
  let clack: ClackLike | null = null;
  try {
    clack = await (input.loadClack ?? loadClackDefault)();
  } catch {
    clack = null;
  }
  return clack
    ? runClackWizard(clack, input.config, input.planned)
    : runReadlineWizard(input.config, input.planned, input);
}

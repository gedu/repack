import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import execa from 'execa';
import * as portPlanner from '../federation/portPlanner.js';
import { federationDev } from '../federation-dev.js';

jest.mock('execa');
const execaMock = execa as unknown as jest.Mock;

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

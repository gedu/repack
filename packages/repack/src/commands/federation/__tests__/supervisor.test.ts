import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import execa from 'execa';
import type { PlannedApp } from '../devPlan.js';
import type { LogSink } from '../supervisor.js';
import { DevSupervisor } from '../supervisor.js';

jest.mock('execa');
const execaMock = execa as jest.MockedFunction<typeof execa>;

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = jest.fn();
}

const planned = (name: string, port: number): PlannedApp => ({
  name,
  role: name === 'host' ? 'host' : 'remote',
  root: `/workspace/${name}`,
  bundler: 'rspack',
  port,
  url: `http://localhost:${port}`,
  spawn: {
    file: process.execPath,
    args: ['/rn/cli.js', 'start', '--no-interactive'],
    cwd: `/workspace/${name}`,
  },
  commandLine: 'node /rn/cli.js start',
});

const plan = [planned('host', 8081), planned('MiniApp', 8082)];

let children: FakeChild[] = [];
let lines: string[] = [];
let sink: LogSink;
let probeStatus: jest.Mock;
let supervisors: DevSupervisor[] = [];

beforeEach(() => {
  children = [];
  lines = [];
  supervisors = [];
  sink = { log: (line: string) => lines.push(line) };
  probeStatus = jest.fn(async () => null);
  execaMock.mockImplementation(((_options: unknown) => {
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as unknown as typeof execa);
});

afterEach(() => {
  // Park every live session: shutdown + exit so no readiness poller
  // outlives its test (polling stops on child exit).
  for (const supervisor of supervisors) supervisor.shutdown('app-exit');
  for (const child of children) child.emit('exit', 0, null);
  jest.useRealTimers();
});

const makeSupervisor = (opts?: { graceMs?: number }) => {
  const supervisor = new DevSupervisor(plan, sink, {
    ...(opts?.graceMs === undefined ? {} : { graceMs: opts.graceMs }),
    probeStatus,
  });
  supervisors.push(supervisor);
  return supervisor;
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('DevSupervisor spawn discipline', () => {
  it('spawns each app with file/args/cwd, no shell, ignore-stdin and piped stdio', () => {
    const supervisor = makeSupervisor();
    void supervisor.run();
    expect(execaMock).toHaveBeenCalledTimes(2);
    // MockedFunction picks execa's (file, options?) overload; the call this
    // supervisor makes is the (file, args, options) one — view it as such.
    const calls = execaMock.mock.calls as unknown as Array<
      [string, string[], Record<string, unknown>]
    >;
    // Host first, then remotes in plan order.
    expect(calls[0]![1]).toEqual(plan[0]!.spawn.args);
    for (const [index, app] of plan.entries()) {
      const call = calls[index]!;
      expect(call[0]).toBe(process.execPath);
      expect(call[1]).toEqual(app.spawn.args);
      const options = call[2];
      expect(options.cwd).toBe(app.spawn.cwd);
      expect(options.stdin).toBe('ignore');
      expect(options.stdout).toBe('pipe');
      expect(options.stderr).toBe('pipe');
      expect(options.shell).toBeFalsy();
    }
  });

  it('prefixes and line-splits partial chunks keeping ANSI and content intact', async () => {
    const supervisor = makeSupervisor();
    void supervisor.run();
    children[0]!.stdout.write('hello wo');
    children[0]!.stdout.write('rld\n');
    children[0]!.stderr.write('\u001b[31mcompiling\u001b[39m\n');
    await flush();
    expect(lines).toEqual([
      '[host] hello world',
      '[host] \u001b[31mcompiling\u001b[39m',
    ]);
  });
});

describe('DevSupervisor readiness', () => {
  it('marks an app running once probeStatus reports packager-status:running', async () => {
    jest.useFakeTimers();
    probeStatus.mockImplementation(async () => 'packager-status:running');
    const supervisor = makeSupervisor();
    void supervisor.run();
    await jest.advanceTimersByTimeAsync(1000);
    expect(supervisor.getStatuses().host).toBe('running');
    expect(supervisor.getStatuses().MiniApp).toBe('running');
  });

  it('marks a dead child failed, never pending forever', async () => {
    jest.useFakeTimers();
    const supervisor = makeSupervisor();
    const run = supervisor.run();
    children[1]!.emit('exit', 1, null);
    await jest.advanceTimersByTimeAsync(1000);
    expect(supervisor.getStatuses().MiniApp).toBe('failed');
    children[0]!.emit('exit', 0, null);
    const result = await run;
    expect(result.exitCode).toBe(1);
    expect(result.apps.MiniApp.status).toBe('failed');
  });
});

describe('DevSupervisor ordered shutdown', () => {
  it('SIGINTs all children, SIGTERMs survivors after the grace window, resolves exit 0 only once all are gone', async () => {
    jest.useFakeTimers();
    const supervisor = makeSupervisor({ graceMs: 5000 });
    const run = supervisor.run();

    supervisor.shutdown('interrupt');
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGINT');
    expect(children[1]!.kill).toHaveBeenCalledWith('SIGINT');

    // Host is polite, MiniApp ignores SIGINT: after the grace window it
    // gets SIGTERM, and the session stays open until BOTH are gone.
    children[0]!.emit('exit', 0, null);
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(5000);
    expect(children[1]!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(settled).toBe(false);
    children[1]!.emit('exit', 0, null);
    const result = await run;
    expect(result.exitCode).toBe(0);
  });

  it('a second interrupt escalates to SIGTERM-all immediately', async () => {
    jest.useFakeTimers();
    const supervisor = makeSupervisor({ graceMs: 5000 });
    void supervisor.run();
    supervisor.shutdown('interrupt');
    supervisor.shutdown('interrupt');
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(children[1]!.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('DevSupervisor crash isolation', () => {
  it('keeps siblings untouched, names the crashed child + code and fails the session', async () => {
    jest.useFakeTimers();
    const supervisor = makeSupervisor();
    const run = supervisor.run();
    children[1]!.emit('exit', 3, null);
    await jest.advanceTimersByTimeAsync(100);
    // Sibling untouched: no signal reached the host.
    expect(children[0]!.kill).not.toHaveBeenCalled();
    expect(
      lines.some((line) => line.includes('MiniApp') && line.includes('3'))
    ).toBe(true);
    supervisor.shutdown('interrupt');
    children[0]!.emit('exit', 0, null);
    children[1]!.emit('exit', 3, null);
    const result = await run;
    expect(result.exitCode).toBe(1);
  });
});

import { EventEmitter } from 'node:events';
import { RunnerConsole } from '../runnerConsole.js';

/** Recording Writable stand-in — write() returns real backpressure values. */
class FakeStream extends EventEmitter {
  chunks: string[] = [];
  writeResult = true;
  isTTY?: boolean = true;
  columns = 80;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.writeResult;
  }
  get output(): string {
    return this.chunks.join('');
  }
}

describe('RunnerConsole sink core (5a)', () => {
  let stream: FakeStream;
  let stdoutWriteBefore: unknown;

  beforeEach(() => {
    stream = new FakeStream();
    stdoutWriteBefore = process.stdout.write;
  });

  afterEach(() => {
    // No global patch may survive — and none may ever be installed.
    expect(process.stdout.write).toBe(stdoutWriteBefore);
  });

  it('writes append-only newline-terminated lines and reports real backpressure', () => {
    const console0 = new RunnerConsole({ stdout: stream });
    expect(console0.log('[host] ready')).toBe(true);
    stream.writeResult = false;
    expect(console0.log('[host] busy')).toBe(false);
    expect(stream.output).toBe('[host] ready\n[host] busy\n');
    expect(process.stdout.write).toBe(stdoutWriteBefore);
  });

  it('never writes to process.stdout — the injected sink is the only outlet', () => {
    const spy = jest.spyOn(process.stdout, 'write');
    const console0 = new RunnerConsole({ stdout: stream });
    console0.log('routed');
    console0.persist(['plan', 'rows']);
    expect(stream.output).toContain('routed');
    expect(stream.output).toContain('plan\nrows\n');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('persists static blocks that stay untouched by later output', () => {
    const console0 = new RunnerConsole({ stdout: stream });
    console0.persist(['PLAN', ' host  8081']);
    const persisted = stream.chunks.length;
    console0.log('[host] compiling');
    // The persisted block is NOT rewritten, redrawn or erased: later lines
    // only ever append after it.
    expect(stream.chunks.slice(0, persisted)).toEqual([
      'PLAN\n',
      ' host  8081\n',
    ]);
    expect(stream.output.endsWith('[host] compiling\n')).toBe(true);
  });

  it('non-TTY mode emits zero cursor escape codes across the whole surface', () => {
    stream.isTTY = undefined;
    const console0 = new RunnerConsole({ stdout: stream });
    console0.log('log line');
    console0.setStatus(['host running']);
    console0.persist(['help']);
    console0.armKeymap({ q: () => undefined });
    console0.onResize(() => undefined);
    console0.release();
    expect(stream.output).toBe('log line\nhost running\nhelp\n');
    expect(stream.output).not.toMatch(/\u001b\[/);
  });
});

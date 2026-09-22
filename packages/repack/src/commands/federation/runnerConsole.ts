import type { WriteStream } from 'node:tty';

/** The one stdout shape the console writes to. */
export type ConsoleStream = Pick<WriteStream, 'write'> & {
  isTTY?: boolean;
  columns?: number;
  on?: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
};

/**
 * The single stdout owner of a federation-dev session (D5).
 *
 * Ownership discipline, pinned by tests:
 * - `process.stdout.write` is NEVER monkey-patched: every producer calls
 *   this object (`log` for live lines, `persist` for static blocks, child
 *   pipe chunks routed through `log`).
 * - Writes are append-only and `\n`-terminated; `log`/`persist` report the
 *   real backpressure (`write` return value), never a lie.
 * - Non-TTY (CI, `--no-interactive` pipes) is plain mode: zero cursor
 *   escape codes, no prompts, no keymap.
 * - The live status block, resize repaint, coalescing and raw-mode
 *   keymap lifecycle (5b) live behind `setStatus`/`armKeymap`/`onResize`/
 *   `release` — in this core they degrade to the same plain discipline.
 */
export class RunnerConsole {
  private stream: ConsoleStream;
  private resizeListeners: Array<() => void> = [];
  private onResizeEvent = () => {
    for (const listener of this.resizeListeners) listener();
  };

  constructor(options: { stdout: ConsoleStream }) {
    this.stream = options.stdout;
    if (typeof this.stream.on === 'function') {
      this.stream.on('resize', this.onResizeEvent);
    }
  }

  private get isTTY(): boolean {
    return this.stream.isTTY === true;
  }

  /** Append one live line (child logs ride this prefixed). Returns backpressure. */
  log(line: string): boolean {
    return this.stream.write(`${line}\n`);
  }

  /** Print a static block (plan table, help, guidance): written once, never redrawn. */
  persist(lines: string[]): void {
    for (const line of lines) this.stream.write(`${line}\n`);
  }

  /**
   * Update the status rows. 5a core: static print per update — the live
   * owned-block implementation replaces this seam in the 5b console polish.
   */
  setStatus(rows: string[]): void {
    this.persist(rows);
  }

  /** Arm the session keymap (raw mode with guaranteed restore). Non-TTY: documented no-op. */
  armKeymap(_map: Record<string, () => void>): void {
    // 5b implements the TTY leg; non-TTY stays a no-op by design.
  }

  /** Register a repaint hook fired on stdout 'resize'. */
  onResize(fn: () => void): void {
    this.resizeListeners.push(fn);
  }

  /** Restore terminal state. Idempotent; also wired to exit-hook by the command. */
  release(): void {
    if (typeof this.stream.off === 'function') {
      this.stream.off('resize', this.onResizeEvent);
    }
    this.resizeListeners = [];
  }
}

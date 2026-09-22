import { PassThrough } from 'node:stream';
import type { FederationConfig } from '../configFile.js';
import type { PlannedApp } from '../devPlan.js';
import type { WizardAnswers, WizardOutcome } from '../wizard.js';
import { runWizard } from '../wizard.js';

// Clack-shaped stub injected through the loadClack seam — the wizard never
// hard-imports @clack/prompts on the test path, so no virtual mocks needed.
interface ClackStub {
  multiselect: jest.Mock;
  select: jest.Mock;
  confirm: jest.Mock;
  text: jest.Mock;
  cancel: jest.Mock;
  isCancel: jest.Mock;
}

const CANCEL = Symbol('cancel');

const makeClack = (): ClackStub => ({
  multiselect: jest.fn(),
  select: jest.fn(),
  confirm: jest.fn(),
  text: jest.fn(),
  cancel: jest.fn(),
  isCancel: jest.fn((value: unknown) => value === CANCEL),
});

const config = {
  host: { manifest: './build/host', root: '.', port: 8081 },
  remotes: {
    MiniApp: {
      manifest: './build/mini',
      root: '.',
      port: 8082,
      standalone: true,
    },
    SideApp: { manifest: './build/side', root: '.', port: 8083 },
  },
} as unknown as FederationConfig;

const planned = [
  { name: 'host', role: 'host', port: 8081 },
  { name: 'MiniApp', role: 'remote', port: 8082, standalone: true },
  { name: 'SideApp', role: 'remote', port: 8083 },
] as unknown as PlannedApp[];

const runWith = async (
  clack: ClackStub,
  overrides: { config?: FederationConfig; planned?: PlannedApp[] } = {}
): Promise<WizardOutcome> =>
  runWizard({
    config: overrides.config ?? config,
    planned: overrides.planned ?? planned,
    loadClack: async () => clack as never,
    input: new PassThrough(),
    output: new PassThrough(),
  });

describe('runWizard (clack path)', () => {
  let clack: ClackStub;

  beforeEach(() => {
    clack = makeClack();
  });

  it('maps the answer sequence to wizard answers in spec order', async () => {
    clack.multiselect.mockResolvedValue(['MiniApp']);
    clack.select.mockResolvedValue('ios');
    clack.confirm
      .mockResolvedValueOnce(true) // host port
      .mockResolvedValueOnce(true) // MiniApp port
      .mockResolvedValueOnce(false); // standalone: no
    const outcome = await runWith(clack);
    expect(outcome).toEqual({
      status: 'completed',
      answers: {
        session: { remotes: ['MiniApp'] },
        platform: 'ios',
        ports: { host: 8081, MiniApp: 8082 },
      },
    });
    // One execution path: the first block is a remotes multiselect over the
    // declared remotes only (host is never optional).
    expect(clack.multiselect).toHaveBeenCalledTimes(1);
    const options = (
      clack.multiselect.mock.calls[0] as unknown as [
        { options: Array<{ value: string }> },
      ]
    )[0].options;
    expect(options.map((option) => option.value)).toEqual([
      'MiniApp',
      'SideApp',
    ]);
    // Answers feed the same planning record the non-interactive path uses.
    expect(
      Object.keys(outcome.status === 'completed' ? outcome.answers.ports : {})
    ).toEqual(['host', 'MiniApp']);
  });

  it('port override: confirm "no" then text answer wins', async () => {
    clack.multiselect.mockResolvedValue(['MiniApp']);
    clack.select.mockResolvedValue('ios');
    clack.confirm
      .mockResolvedValueOnce(false) // host port: override
      .mockResolvedValueOnce(true) // MiniApp port
      .mockResolvedValueOnce(false); // standalone
    clack.text.mockResolvedValue('8090');
    const outcome = await runWith(clack);
    expect(outcome.status === 'completed' && outcome.answers.ports.host).toBe(
      8090
    );
    expect(clack.text).toHaveBeenCalledTimes(1);
  });

  it('platform "all" means no platform override', async () => {
    clack.multiselect.mockResolvedValue(['MiniApp']);
    clack.select.mockResolvedValue('all');
    clack.confirm.mockResolvedValue(true); // all port confirms
    const outcome = await runWith(clack);
    expect(outcome.status === 'completed' && outcome.answers.platform).toBe(
      undefined
    );
  });

  it('standalone is confirmed for selected remotes that declare it', async () => {
    clack.multiselect.mockResolvedValue(['MiniApp']);
    clack.select.mockResolvedValue('all');
    clack.confirm
      .mockResolvedValueOnce(true) // host port
      .mockResolvedValueOnce(true) // MiniApp port
      .mockResolvedValueOnce(true); // standalone: yes
    const outcome = await runWith(clack);
    expect(
      outcome.status === 'completed' && outcome.answers.session.standaloneRemote
    ).toBe('MiniApp');
  });

  it('never offers standalone for remotes without the declaration', async () => {
    // SideApp declares no standalone flag and is the only selection.
    clack.multiselect.mockResolvedValue(['SideApp']);
    clack.select.mockResolvedValue('all');
    clack.confirm
      .mockResolvedValueOnce(true) // host port
      .mockResolvedValueOnce(true); // SideApp port
    const outcome = await runWith(clack);
    // No third confirm: the standalone block never ran for SideApp.
    expect(clack.confirm).toHaveBeenCalledTimes(2);
    expect(
      outcome.status === 'completed' && outcome.answers.session.standaloneRemote
    ).toBeUndefined();
  });

  // Every step must be self-explanatory BEFORE any key press: the clack
  // option carries the key legend and the visible message embeds it (clack
  // 0.9.1 has no prompt-level hint that renders eagerly).
  it('every clack step carries its key legend in hint and message', async () => {
    clack.multiselect.mockResolvedValue(['MiniApp']);
    clack.select.mockResolvedValue('ios');
    clack.confirm
      .mockResolvedValueOnce(false) // host port: override -> text step
      .mockResolvedValueOnce(true) // MiniApp port
      .mockResolvedValueOnce(false); // standalone: no
    clack.text.mockResolvedValue('8090');
    await runWith(clack);

    const optionsOf = (call: unknown[]): { message: string; hint?: string } =>
      call[0] as { message: string; hint?: string };

    const multi = optionsOf(clack.multiselect.mock.calls[0]);
    const multiLegend = '↑↓ move · space toggle · a toggle all · enter confirm';
    expect(multi.hint).toBe(multiLegend);
    expect(multi.message).toContain(multiLegend);

    const select = optionsOf(clack.select.mock.calls[0]);
    const selectLegend = '↑↓ move · enter confirm';
    expect(select.hint).toBe(selectLegend);
    expect(select.message).toContain(selectLegend);

    // Port flow: the confirm and the override text both carry the port legend.
    const portConfirm = optionsOf(clack.confirm.mock.calls[0]);
    const portLegend = 'type a port · enter to accept';
    expect(portConfirm.hint).toBe(portLegend);
    expect(portConfirm.message).toContain(portLegend);
    const portText = optionsOf(clack.text.mock.calls[0]);
    expect(portText.hint).toBe(portLegend);
    expect(portText.message).toContain(portLegend);

    // Standalone confirm gets the left/right legend.
    const standaloneConfirm = optionsOf(clack.confirm.mock.calls[2]);
    const standaloneLegend = '←/→ choose · enter confirm';
    expect(standaloneConfirm.hint).toBe(standaloneLegend);
    expect(standaloneConfirm.message).toContain(standaloneLegend);
  });

  it('cancel returns the cancelled outcome and says so via clack cancel', async () => {
    clack.multiselect.mockResolvedValue(CANCEL);
    const outcome = await runWith(clack);
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(clack.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('runWizard (readline fallback)', () => {
  const feed = (answers: string[]) => {
    const input = new PassThrough();
    // readline/promises consumes lines as they arrive.
    setTimeout(() => input.write(`${answers.join('\n')}\n`), 0);
    return input;
  };

  const runFallback = async (answers: string[]) => {
    const output = new PassThrough();
    let captured = '';
    output.on('data', (chunk) => {
      captured += String(chunk);
    });
    const outcome = await runWizard({
      config,
      planned,
      loadClack: async () => {
        throw new Error('clack unavailable');
      },
      input: feed(answers),
      output,
    });
    return { outcome, captured };
  };

  it('returns the same output shape as the clack path', async () => {
    const { outcome, captured } = await runFallback([
      'MiniApp', // remotes
      'ios', // platform
      '', // host port: default
      '8090', // MiniApp port: override
      'n', // standalone
    ]);
    const expected: WizardAnswers = {
      session: { remotes: ['MiniApp'] },
      platform: 'ios',
      ports: { host: 8081, MiniApp: 8090 },
    };
    expect(outcome).toEqual({ status: 'completed', answers: expected });
    expect(captured).toContain('MiniApp');
    expect(captured).toContain('8081');
  });

  it('empty answers take the defaults (all remotes, all platforms)', async () => {
    // six questions: remotes, platform, three ports, standalone(MiniApp)
    const { outcome } = await runFallback(['', '', '', '', '', 'n']);
    expect(outcome).toEqual({
      status: 'completed',
      answers: {
        session: { remotes: ['MiniApp', 'SideApp'] },
        platform: undefined,
        ports: { host: 8081, MiniApp: 8082, SideApp: 8083 },
      },
    });
  });

  it('fallback questions carry the legend inline (readline has no chrome)', async () => {
    const { captured } = await runFallback([
      'MiniApp', // remotes
      'ios', // platform
      '8090', // host port
      '', // MiniApp port: default
      'n', // standalone
    ]);
    expect(captured).toContain('type names · enter to accept');
    expect(captured).toContain('type ios/android · enter to accept');
    expect(captured).toContain('type a port · enter to accept');
    expect(captured).toContain('type y/n · enter to accept');
  });

  it('EOF on stdin cancels like the clack path', async () => {
    const input = new PassThrough();
    setTimeout(() => input.end(), 0);
    const outcome = await runWizard({
      config,
      planned,
      loadClack: async () => {
        throw new Error('clack unavailable');
      },
      input,
      output: new PassThrough(),
    });
    expect(outcome).toEqual({ status: 'cancelled' });
  });
});

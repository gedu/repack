import { bundleCommandOptions, startCommandOptions } from '../options.js';

describe.each([
  ['start', startCommandOptions],
  ['bundle', bundleCommandOptions],
])('%s command options', (_, options) => {
  const bundlerOption = options.find(
    (option) => option.name === '--bundler <string>'
  );

  test.each(['rspack', 'webpack'])('accepts the %s bundler', (bundler) => {
    expect(bundlerOption?.parse?.(bundler)).toBe(bundler);
  });

  test('rejects an unsupported bundler', () => {
    expect(() => bundlerOption?.parse?.('metro')).toThrow(
      'Invalid bundler "metro". Expected "rspack" or "webpack".'
    );
  });
});

describe('--standalone registration', () => {
  test.each([
    ['start', startCommandOptions],
    ['bundle', bundleCommandOptions],
  ])('%s command exposes --standalone as a boolean flag', (_, options) => {
    const standaloneOption = options.find(
      (option) => option.name === '--standalone'
    );
    // Boolean commander flag: no parse, no default — presence means true.
    expect(standaloneOption).toBeDefined();
    expect(standaloneOption?.parse).toBeUndefined();
  });
});

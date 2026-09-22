import { bundle } from '../bundle.js';
import commands, { createBoundCommands } from '../index.js';
import type { BundleArguments, CliConfig, StartArguments } from '../types.js';

jest.mock('../bundle.js');
jest.mock('../federationDoctor.js');
jest.mock('../federationInit.js');
jest.mock('../federationManifest.js');
jest.mock('../start.js');

const cliConfig: CliConfig = {
  root: '/project',
  platforms: ['ios'],
  reactNativePath: '/project/node_modules/react-native',
};

const args = {
  dev: true,
  host: '',
  platform: 'ios',
} satisfies BundleArguments & StartArguments;

describe('createBoundCommands', () => {
  const consoleWarn = jest.spyOn(console, 'warn').mockImplementation();

  test('warns when the bound command overrides --bundler', async () => {
    const [command] = createBoundCommands('webpack');

    await command.func([], cliConfig, { ...args, bundler: 'rspack' });

    expect(consoleWarn).toHaveBeenCalledWith(
      'Ignoring "--bundler rspack" because the deprecated "@callstack/repack/commands/webpack" entry point explicitly selects webpack. Use "@callstack/repack/commands" to select a bundler with --bundler.'
    );
    expect(bundle).toHaveBeenCalledWith(
      [],
      cliConfig,
      { ...args, bundler: 'rspack' },
      'webpack'
    );
  });

  test.each([undefined, 'webpack' as const])(
    'does not warn when --bundler is %s',
    async (bundler) => {
      const [command] = createBoundCommands('webpack');

      await command.func([], cliConfig, { ...args, bundler });

      expect(consoleWarn).not.toHaveBeenCalled();
    }
  );
});

describe('command registry', () => {
  test('federation-init is a flat command alongside the other federation commands', () => {
    const names = commands.map((command) => command.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'federation-init',
        'federation-doctor',
        'federation-manifest',
      ])
    );

    const init = commands.find((command) => command.name === 'federation-init');
    // Flat RN-CLI command object: name/description/options/func, no
    // subcommand tree.
    expect(typeof init?.func).toBe('function');
    expect(Array.isArray(init?.options)).toBe(true);
    expect(typeof init?.description).toBe('string');
    expect(init).not.toHaveProperty('subcommands');
  });

  test('federation-init is not exposed through the deprecated bound entry points', () => {
    const names = createBoundCommands('webpack').map((command) => command.name);
    expect(names).not.toContain('federation-init');
  });
});

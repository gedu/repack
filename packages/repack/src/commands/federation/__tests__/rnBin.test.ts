import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLIError } from '../../../helpers/index.js';
import { resolveReactNativeBin } from '../rnBin.js';

const FIXTURES = path.join(__dirname, '__fixtures__', 'rnbin');
const appDir = (app: string) => path.join(FIXTURES, app);

describe('resolveReactNativeBin', () => {
  it('resolves the local package cli.js to an absolute existing path', () => {
    const bin = resolveReactNativeBin(appDir('app'));
    expect(bin).toBe(
      path.join(FIXTURES, 'app', 'node_modules', 'react-native', 'cli.js')
    );
    expect(fs.existsSync(bin)).toBe(true);
  });

  it('follows a pnpm-symlinked package to an absolute script path', () => {
    const bin = resolveReactNativeBin(appDir('pnpmapp'));
    expect(path.isAbsolute(bin)).toBe(true);
    expect(fs.realpathSync(bin)).toBe(
      fs.realpathSync(
        path.join(
          FIXTURES,
          'pnpmapp',
          'node_modules',
          '.pnpm',
          'react-native@100.0.0',
          'node_modules',
          'react-native',
          'scripts',
          'cli.js'
        )
      )
    );
  });

  it('prefers the local package over a planted PATH shim', () => {
    // Threat row "Executable-file classification": resolution is a local
    // require.resolve chain — PATH is never consulted, so a global
    // react-native can never shadow the app's own install.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnbin-shim-'));
    const shim = path.join(shimDir, 'react-native');
    fs.writeFileSync(shim, '#!/bin/sh\necho shim\n');
    fs.chmodSync(shim, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ''}`;
    try {
      const bin = resolveReactNativeBin(appDir('app'));
      expect(bin).not.toContain(shimDir);
      expect(bin).toBe(
        path.join(FIXTURES, 'app', 'node_modules', 'react-native', 'cli.js')
      );
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it('fails with a clean CLIError naming react-native when no local package exists', () => {
    // jest's module registry always resolves a real react-native from the
    // repo tree, so the miss leg is exercised through the documented
    // resolution seam with a Node-shaped MODULE_NOT_FOUND.
    const miss = Object.assign(
      new Error("Cannot find module 'react-native/package.json'"),
      { code: 'MODULE_NOT_FOUND' }
    );
    let caught: unknown;
    try {
      resolveReactNativeBin('/isolated/app-without-react-native', {
        requireResolve: () => {
          throw miss;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CLIError);
    const message = (caught as Error).message;
    expect(message).toContain('react-native');
    expect(message).toContain('/isolated/app-without-react-native');
    expect(message).not.toMatch(/\n\s+at\s/);
  });
});

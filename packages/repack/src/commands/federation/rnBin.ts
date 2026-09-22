import fs from 'node:fs';
import path from 'node:path';
import { CLIError } from '../../helpers/index.js';

/** The resolution call this module rides — injectable for tests (jest's
 * own resolver never misses, so the missing-package mapping is unpinnable
 * without the seam; production always uses the real `require.resolve`). */
type ResolvePackages = (
  request: string,
  options: { paths: string[] }
) => string;

/**
 * Resolve the app's LOCAL `react-native` CLI script to an absolute path.
 *
 * Resolution is a pure module-resolution chain — `require.resolve` over
 * `[appRoot, ...extraPaths, cwd]` — so PATH is never consulted and a
 * global `react-native` can never shadow the app's own install (threat row
 * "Executable-file classification"). The chain mirrors Node's own upward
 * `node_modules` walk, which also follows pnpm's symlinked layout: the
 * returned path is the real, absolute script file.
 *
 * The plan executes the result as `process.execPath <cli.js> …` — spawning
 * the `.bin/react-native` shim would break under some pnpm layouts, the
 * resolved cli.js is deterministic.
 *
 * @param appRoot the app whose install owns the CLI
 * @param options.extraPaths additional resolution bases (e.g. the workspace
 * config directory), consulted after the app root
 * @param options.requireResolve resolution seam for tests only
 */
export function resolveReactNativeBin(
  appRoot: string,
  options: {
    extraPaths?: string[];
    requireResolve?: ResolvePackages;
  } = {}
): string {
  const { extraPaths = [], requireResolve = require.resolve } = options;
  let packageJsonPath: string;
  try {
    packageJsonPath = requireResolve('react-native/package.json', {
      paths: [appRoot, ...extraPaths, process.cwd()],
    });
  } catch {
    throw new CLIError(
      `Cannot resolve the "react-native" package from ${appRoot} — ` +
        'federation-dev runs each app with its own local react-native CLI; ' +
        'install react-native in the app (or run from inside the workspace).'
    );
  }

  const packageDir = path.dirname(packageJsonPath);
  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
    bin?: Record<string, string> | string;
  };
  const bin =
    typeof manifest.bin === 'string'
      ? manifest.bin
      : manifest.bin?.['react-native'];
  if (!bin) {
    throw new CLIError(
      `The react-native package at ${packageDir} declares no ` +
        '"bin.react-native" script — it cannot be used to start an app.'
    );
  }
  return path.resolve(packageDir, bin);
}

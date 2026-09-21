import path from 'node:path';
import { buildSharedEntries } from '../../plugins/federationManifest/shared.js';
import type { FederationManifestSharedEntry } from '../../plugins/federationManifest/types.js';
import { getConfigFilePath } from '../common/config/getConfigFilePath.js';
import { loadProjectConfig } from '../common/config/loadProjectConfig.js';

/**
 * An app's bundler configuration could not be located, evaluated, or does
 * not instantiate a federation plugin. Tools map this to exit code 2 —
 * "could not run" — printing only `message`, never a stack.
 */
export class ConfigEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigEvalError';
  }
}

/** What extraction learned from one app's configuration. */
export interface ExtractedAppShared {
  /** Federation name declared by the plugin, else the app dir basename. */
  name: string;
  /** Constructor name of the matched plugin ('ModuleFederationPluginV1'…),
   * for consumers that must mirror the plugin version (federation-init). */
  pluginName: string | undefined;
  /** Virtual manifest entries: the user's shared option resolved against
   * this app's installed packages. */
  shared: FederationManifestSharedEntry[];
}

/** The minimal environment a config function is evaluated with. */
interface SyntheticConfigEnv {
  mode: 'production';
  context: string;
  platform: 'ios';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function discoverConfigPath(root: string, customPath?: string): string {
  // Same discovery order the bundler commands use (rspack first), with an
  // explicit --config-style path always winning.
  try {
    return getConfigFilePath('rspack', root, customPath);
  } catch {
    // fall through to webpack candidates
  }
  try {
    return getConfigFilePath('webpack', root, customPath);
  } catch {
    throw new ConfigEvalError(
      `No bundler configuration found in ${root} — the dry-run reads the ` +
        'shared setup from the app rspack or webpack configuration.'
    );
  }
}

/**
 * Evaluate one app's bundler configuration in-process and extract the
 * `shared` option from the Module Federation plugin instance it
 * instantiates, resolved into manifest-shaped entries against the app's
 * installed versions.
 *
 * The config is loaded exactly the way the bundler loads it
 * (`loadProjectConfig`), so a config that cannot be evaluated here fails
 * the same way it would fail a build. Duck-typed plugin detection
 * (`getSharedConfiguration`) keeps this module free of the heavy plugin
 * imports; the trust level is the same as running the bundler on this
 * machine's own configs.
 */
export async function extractAppShared(
  root: string,
  options: { configPath?: string } = {}
): Promise<ExtractedAppShared> {
  const configPath = discoverConfigPath(root, options.configPath);

  let config: unknown;
  try {
    config = await loadProjectConfig(configPath);
  } catch (error) {
    throw new ConfigEvalError(
      `Failed to load bundler config ${configPath}: ${messageOf(error)}`
    );
  }

  if (typeof config === 'function') {
    const env: SyntheticConfigEnv = {
      mode: 'production',
      context: root,
      platform: 'ios',
    };
    try {
      config = await (
        config as (env: SyntheticConfigEnv, argv: object) => unknown
      )(env, {});
    } catch (error) {
      throw new ConfigEvalError(
        `Bundler config ${configPath} failed while producing its ` +
          `configuration: ${messageOf(error)}`
      );
    }
  }

  const plugins = Array.isArray((config as { plugins?: unknown[] })?.plugins)
    ? ((config as { plugins: unknown[] }).plugins as unknown[])
    : [];
  const plugin = plugins.find(
    (candidate) =>
      typeof (candidate as { getSharedConfiguration?: unknown })
        ?.getSharedConfiguration === 'function'
  ) as
    | {
        getSharedConfiguration: () => unknown;
        config?: { name?: unknown };
        constructor?: { name?: string };
      }
    | undefined;

  if (!plugin) {
    throw new ConfigEvalError(
      `No Module Federation plugin instance with getSharedConfiguration() ` +
        `found in ${configPath} — the dry-run reads the shared option from ` +
        'the ModuleFederationPluginV1/V2 the config instantiates.'
    );
  }

  return {
    name:
      typeof plugin.config?.name === 'string' && plugin.config.name
        ? plugin.config.name
        : path.basename(root),
    pluginName: plugin.constructor?.name,
    shared: buildSharedEntries(plugin.getSharedConfiguration(), root),
  };
}

# Federation Tools — Design

Effort: tooling that makes multi-app Module Federation (host + remotes, often in
separate repos) safe to ship with Re.Pack. This doc tracks the thinking and the
decisions as the effort evolves, one section per shipped piece.

## The problem (verified in code)

- `requiredVersion` defaults to `'*'` in both plugins
  (`packages/repack/src/plugins/ModuleFederationPluginV1.ts:194`,
  `ModuleFederationPluginV2.ts:209`). No build-time or runtime code ever
  compares host vs remote versions.
- Native module compatibility is documented in a single sentence
  (`website/src/latest/docs/getting-started/microfrontends.md:30`) and enforced
  by nothing.
- Shared config blocks are duplicated by hand across host and every remote;
  `eager` conventions are social, not code.
- Result: version/native drift is only discovered as runtime crashes
  (issues #1367, #1368, #1428).

## The base primitive: a Repack federation manifest

Everything downstream (doctor, CI gate, init/codemod, dev runner) consumes one
artifact: a machine-readable manifest emitted at build time by
`ModuleFederationPluginV1`/`V2`. The manifest, not the doctor, is the primitive.

### Alignment with upstream (rspack.rs / Module Federation 2.0)

MF 2.0 already standardizes `mf-manifest.json`
([spec](https://github.com/module-federation/core/blob/main/arch-doc/manifest-specification.md)):
`id`, `name`, `metaData`, `shared[]` (with resolved `version`, `singleton`,
`requiredVersion`, `hash`, `assets`), `remotes[]`, `exposes[]`. The MF plugin
that Repack V2 wraps already emits it. We do **not** invent a parallel format:

- The Repack manifest **reuses the upstream schema shape verbatim** and adds a
  single React-Native extension block. Web MF and Repack consumers can parse
  the common part with the same tooling.
- Distinct filename to avoid collision with the upstream `mf-manifest.json`
  (which V2's inner plugin may also emit): default
  **`repack-federation-manifest.json`**, configurable.
- Option naming mirrors upstream so it is muscle memory for rspack/MF users:
  `manifest?: boolean | { fileName?: string; filePath?: string; native?: ... }`
  on both plugin configs — same shape as `PluginManifestOptions` in
  `@module-federation/rspack`.

### Schema (v1) — `repack-federation-manifest.json`

```jsonc
{
  "manifestVersion": 1,
  // --- upstream mf-manifest-compatible fields ---
  "id": "catalog",
  "name": "catalog",
  "metaData": {
    "name": "catalog",
    "globalName": "catalog",
    "type": "remote",
    "buildInfo": { "buildVersion": "<git sha or package version>", "buildName": "catalog" },
    "remoteEntry": { "name": "remoteEntry.container.jsbundle", "path": "", "type": "var" },
    "publicPath": "https://cdn.example.com/catalog/"
  },
  "shared": [
    {
      "name": "react",
      "version": "19.1.0",            // RESOLVED version, not '*'
      "singleton": true,
      "eager": true,
      "requiredVersion": "^19.1.0",
      "assets": { "js": { "sync": ["..."], "async": [] }, "css": { "js": ..., "async": [] } }
    }
  ],
  "remotes": [ /* upstream shape: federationContainerName, moduleName, alias, entry */ ],
  "exposes": [ /* upstream shape: id, name, path, assets */ ],

  // --- React Native extension block (Repack-specific, additive) ---
  "reactNative": {
    "version": "0.80.1",
    "newArch": true,
    "platforms": ["ios", "android"],
    "nativeModules": [
      {
        "package": "react-native-svg",
        "version": "15.11.2",
        "modules": ["RNSVG", "RNSVGPackage"],
        "turboModule": true,
        "confidence": "static"       // static | heuristic — see detection
      }
    ],
    "dynamicImportDetected": true     // when true, nativeModules is NOT exhaustive
  }
}
```

`manifestVersion` is the compatibility contract for consumers; additive fields
only within a major, bumps are the doctor's job to interpret.

### Resolved versions

Today nothing in the MF plugins reads installed versions — `requiredVersion`
stays `'*'` and resolution is deferred to the bundler internals. Emitting real
versions means, at emission time, resolving each shared dep from
`compiler.context` (the pattern `DevelopmentPlugin.ts:100-118` already uses for
RN's own `package.json`) and, where available, cross-checking against
compilation stats. No change to how the bundler resolves anything — the
manifest **observes**, it never alters resolution.

### Native module detection — honest scope

- **Build-time (static):** walk the compilation module graph; map every module
  that resolves inside `node_modules/<pkg>` with native code (presence of
  `ios/`/`android/` or `codegenConfig` in `package.json`) to a declaration.
  This is the same dependency→capability table pattern as
  `commands/common/config/validatePlugins.ts`, inverted (we emit instead of warn).
- **Honesty flag:** if any dynamic `require()`/template-literal import is found
  in the graph, `dynamicImportDetected: true` is set. The doctor must treat a
  `heuristic`/possibly-incomplete list as "verify these", never as a green
  checkmark. We never claim exhaustive static guarantees we cannot make.
- **Runtime (later PR, separate):** wrap remote module resolution failures
  (ScriptManager/ResolverPlugin) to report
  `remote X requested NativeY; host manifest does not declare it` instead of a
  raw crash. Build-time manifest + runtime error-context are complementary.

### Backward compatibility — non-negotiables

1. **Opt-in.** Default `manifest: false` (or absent). With the flag absent,
   plugin output is byte-identical to today. This is test-enforced with
   existing snapshot tests.
2. **No unconditional hook taps.** Existing MF plugin tests use bare compiler
   mocks without `hooks` (`__tests__/ModuleFederationPluginV1.test.ts:8-15`);
   hook registration happens only when the option is enabled.
3. **Emit via `afterProcessAssets`** (the `ManifestPlugin.ts:14-32` precedent),
   bundler-agnostic (`compilation.emitAsset` + `compiler.webpack.sources.RawSource`
   work on both webpack and Rspack — no `isRspackCompiler` branch needed).
4. **Filename collisions:** dev-server asset allowlist
   (`commands/consts.ts:37-48`) must serve the new filename; verify the emitted
   `.json` passing through `AssetsCopyProcessor` (it rewrites the
   ManifestPlugin's `.json` today) and `OutputPlugin`'s entry-chunk assertions.
5. **Migration path to default-on:** opt-in for a minor line → docs + codemod
   that adds the flag → default-on in the next major, with `manifest: false`
   escape hatch retained. No breaking change before that major.

## Delivery plan — one feature per PR

Each PR is shippable alone and lands with docs in the same PR.

- **PR 1 — Manifest emission.** `manifest` option on V1+V2, schema v1,
  resolved versions, native module block, dev-server allowlist, unit tests,
  docs page (`website/src/latest/docs/features/`), agent_context kept in sync.
- **PR 2 — Manifest inspection CLI.** `repack federation manifest <path|url>`:
  pretty-prints a manifest (local file, built output dir, or remote URL).
  Trivially useful, first consumer, validates schema ergonomics.
- **PR 3 — `repack federation doctor`.** Inputs: host + list of remotes
  (local paths or URLs). Compares manifests: shared-version/range drift,
  singleton/eager mismatches, native modules the host does not declare.
  `--format json` + exit codes so it runs as a CI gate (multi-repo story).
- **PR 4 — Single-source shared config + retrofit.** `defineShared()` helper
  (or shared `shared.config.ts` convention) deriving versions from real
  `package.json`; codemod `repack federation init` that generates/repairs
  host & remote configs from installed versions.
- **PR 5 — Dev runner (interactive).** `repack federation dev`: light
  `@clack/prompts`-style selection (which remotes, iOS/Android, auto ports),
  then exits interactive mode and streams raw logs in plain scrollable
  terminal output. Equal non-interactive flags (`--ios --remotes cart,catalog
  --ci`) for CI. Status dashboard (N servers, ports, health) as a web page,
  not a TUI — bundler output and alternate-screen UIs fight each other.
- **PR 6+ — Runtime mismatch context** (ResolverPlugin/ScriptManager error
  enrichment), roadmap debt (#1420 V1/V2 duality, v5 docs, Expo #1413).

## User interaction contract

Every shipped command must have: deterministic non-interactive flags (CI
parity with the wizard), human-readable default output, `--json` for
machines, actionable messages that name the package and the versions in
conflict, and a docs page with copy-pasteable examples.
## Open decisions

- [x] Manifest filename/option naming (proposed above) — confirmed; shipped as
  `manifest` / `repack-federation-manifest.json` in PR 1.
- [x] `buildVersion` source: chain implemented in PR 1 — `git rev-parse
  --short HEAD` in `compiler.context` (non-fatal), else root `package.json`
  `version`, else `"unknown"`.
- [ ] Doctor host input: does the host need the manifest option enabled, or
  may the doctor fall back to `package.json` heuristics with a `degraded`
  badge?

## PR 1 implementation notes (as built)

Deltas from the design above, all deliberate:

- **Option collision in V2.** `ModuleFederationPluginOptions` from
  `@module-federation/sdk` already declares `manifest?: boolean |
  PluginManifestOptions` (it configures the wrapped plugin's own
  `mf-manifest.json`). Repack V2 now **consumes** `manifest` for the Repack
  manifest and does not forward it to the inner plugin; the inner plugin keeps
  its default behavior and still emits `mf-manifest.json`. Consequence: V2
  users can no longer tune the upstream manifest options through Repack's
  config. Accepted tradeoff for naming symmetry; documented on the features
  page.
- **`reactNative.newArch` omitted in v1 output.** Not reliably detectable from
  the bundler context (it is an app build flag, not a JS graph fact). The
  field is reserved in the schema type but never written; PR 3 (doctor) must
  not depend on it.
- **`reactNative.note` added** (additive string field): explains disabled
  (`nativeAnalysis: false`), degraded (scan threw), or non-exhaustive
  (dynamic import detected) native lists.
- **Confidence downgrade:** when `dynamicImportDetected` is true, every
  `static` entry drops to `heuristic`; the label reflects list completeness,
  not just per-package evidence.
- **Dev-server allowlist** covers the default filename only; a custom
  `manifest.fileName` is served from disk/CDN, not the dev-server asset
  route. Revisit if users ask.
- **Emission shape:** pretty-printed JSON via `compilation.emitAsset` in
  `compilation.hooks.afterProcessAssets`; collision with an existing asset of
  the same name skips emission with a warning instead of erroring.
- **Native toggle named `nativeAnalysis`.** The sketch above had `native?:`;
  the shipped boolean is `nativeAnalysis` to avoid reading as "include native
  code".
- **Chunk-level detachment verified:** `emitAsset` without chunk association
  keeps the manifest out of `chunk.auxiliaryFiles`, which is what keeps
  `OutputPlugin`/`AssetsCopyProcessor` (chunk-iteration based) from touching
  it; asserted in `federationManifestCompilation.test.ts` against a real
  rspack run plus a direct `AssetsCopyProcessor` memfs test.


## Referenced surface (verified 2026-09)

- `packages/repack/src/plugins/ModuleFederationPluginV1.ts` / `V2.ts` — no
  compiler hooks today; `apply()` is config-munging then delegates; hook taps
  go inside `apply()` gated on the option.
- `packages/repack/src/plugins/ManifestPlugin.ts:14-32` — emit pattern.
- `packages/repack/src/plugins/DevelopmentPlugin.ts:100-118` — resolved
  version read pattern.
- `packages/repack/src/commands/consts.ts:37-48` — dev-server asset allowlist.
- `packages/repack/src/modules/FederationRuntimePlugins/ResolverPlugin.ts:43-86`
  — existing runtime consumer of upstream `mf-manifest.json` (version-as-URL).

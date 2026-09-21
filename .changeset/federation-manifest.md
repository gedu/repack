---
'@callstack/repack': minor
---

Add an opt-in `manifest` option to both module federation plugins. When set, the build emits `repack-federation-manifest.json` next to the bundle: shared dependencies report the versions actually installed in `node_modules` instead of the `*` range the plugins configure by default, and an additive `reactNative` block lists the native modules found in the module graph. Field shapes follow the upstream `mf-manifest.json` spec, so existing tooling can parse the file as-is. With the option absent, builds are byte-identical to before.

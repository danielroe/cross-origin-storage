# vite-plugin-cross-origin-storage

> [!WARNING]
> Experimental. The [Cross-Origin Storage API](https://github.com/WICG/cross-origin-storage) is an early-stage proposal with no native browser support yet, and this plugin's chunk format is not stable. Do not depend on it in production.

A Vite plugin that extracts shared dependencies (such as `vue`) into **content-addressed** chunks that can be loaded from [Cross-Origin Storage (COS)](https://github.com/WICG/cross-origin-storage). When two sites build the same dependency at the same version, they produce byte-identical chunks with the same SHA-256, so a browser that supports COS can serve the chunk from a shared store instead of fetching it again per origin.

This builds on [Thomas Steiner](https://github.com/tomayac)'s original [`vite-plugin-cross-origin-storage`](https://github.com/tomayac/vite-plugin-cross-origin-storage), and is intended as an update of it. It explores a content-addressed chunking and decentralised (registry-free) sharing model on top of the loader and import-rewriting approach Thomas established. The aim is to merge these changes back upstream.

## How it works

At build time, for each package matched by `packages`:

1. The package is externalised from the app graph and re-bundled on its own with `rolldown`, **preserving every export** (no tree-shaking). This makes a chunk's bytes depend only on the package, never on which parts of it the app happened to import, so it is identical across sites.
2. Its dependencies are discovered and bundled too, recursively, so managing one package implicitly manages its whole import subgraph (e.g. `vue` pulls in `@vue/*`). Shared dependencies become their own chunks rather than being duplicated, which also preserves singletons like `@vue/reactivity`.
3. Chunks are hashed **bottom-up**: each chunk imports its dependencies by their content hash (`cos1:<sha256>`), so a chunk can only be hashed once its dependencies are. The result is purely a function of the source plus a pinned build recipe.
4. A runtime loader is injected. It looks each managed chunk up in COS by hash, falling back to the network and storing the fetched chunk for next time, then wires everything together through an import map.

The `cos1:` prefix is a **recipe version**. Chunks are only byte-identical across builds that use the same recipe (the same `rolldown` version and options); the prefix is bumped when the recipe changes so chunks built under different recipes can never collide on the same hash.

## Installation

```bash
npm install -D vite-plugin-cross-origin-storage
```

## Usage

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { cosPlugin } from 'vite-plugin-cross-origin-storage'

export default defineConfig({
  plugins: [
    cosPlugin({
      packages: [/^(?:vue$|@vue\/)/],
    }),
  ],
})
```

For a plain client build, the plugin injects the loader into `index.html` and removes the default entry `<script>` automatically.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `packages` | `Array<string \| RegExp>` | (required) | Packages to extract into COS chunks. Matched against the imported specifier; a plain string is an exact match. Transitive dependencies are collected automatically. |
| `base` | `string` | Vite's `base` + `build.assetsDir` | Public path the chunks are served from. |
| `loaderEntry` | `string` | bundled loader | Path to a custom runtime loader entry. |
| `onGenerated` | `(scriptContent: string) => void` | (unset) | Receives the loader `<script>` body once chunks are emitted. SSR frameworks inject it into their own rendered HTML; when omitted the plugin injects into `index.html`. |

## Browser support

The [Cross-Origin Storage API](https://github.com/WICG/cross-origin-storage) is not yet implemented in any browser. You can try it today with the [Cross-Origin Storage browser extension](https://github.com/web-ai-community/cross-origin-storage-extension). Without it, the loader falls back to ordinary network requests, so the build still works everywhere; it just doesn't share chunks.

## Limitations

- **Managed packages must be self-contained.** A package whose source imports build-time virtuals (e.g. `#build/*`, `#imports`) cannot be bundled standalone and is rejected with a clear error. It also wouldn't be shareable, since its output would differ per app.
- **Single-entry builds.** The loader wires up one entry chunk; multi-page builds with several HTML entries are not yet supported.
- **The app entry is never COS-shared.** It is app-specific and is loaded from the network.
- **Determinism is recipe-scoped.** Sharing only happens between builds on the same package version *and* the same recipe (`cos1:`).

## Credits

Original plugin and the COS loader / import-rewriting approach by [Thomas Steiner](https://github.com/tomayac) ([`tomayac/vite-plugin-cross-origin-storage`](https://github.com/tomayac/vite-plugin-cross-origin-storage)).

## License

MIT

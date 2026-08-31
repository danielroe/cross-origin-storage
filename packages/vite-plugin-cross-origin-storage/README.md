# vite-plugin-cross-origin-storage

> [!WARNING]
> Experimental. The [Cross-Origin Storage API](https://github.com/WICG/cross-origin-storage) is an early-stage proposal with no native browser support yet, and this plugin's chunk format is not stable. Do not depend on it in production.

A Vite plugin that extracts shared dependencies (such as `vue`) into **content-addressed** chunks that can be loaded from [Cross-Origin Storage (COS)](https://github.com/WICG/cross-origin-storage). When two sites build the same dependency at the same version, they produce byte-identical chunks with the same SHA-256, so a browser that supports COS can serve the chunk from a shared store instead of fetching it again per origin.

This builds on [Thomas Steiner](https://github.com/tomayac)'s original [`vite-plugin-cross-origin-storage`](https://github.com/tomayac/vite-plugin-cross-origin-storage), and is intended as an update of it. It explores a content-addressed chunking and decentralised (registry-free) sharing model on top of the loader and import-rewriting approach Thomas established. The aim is to merge these changes back upstream.

## How it works

At build time, for each package matched by `packages`:

1. The **package** is externalised from the app graph and re-bundled on its own with `rolldown`, **preserving every export** (no tree-shaking). Every entry point the package declares in its `exports` is built together, with code splitting on, so modules shared between entry points land in a single chunk.
2. Only imports that **leave** the package are externalised; imports that stay inside it are bundled. A package that ships pre-bundled `dist` files (`vue`, `preact`) has only the first kind, but one that ships unbundled source (`svelte`) has thousands of the second, and bundling them is what keeps it to a handful of chunks rather than one per source file. It is also what keeps the package's singletons intact — `svelte` and `svelte/internal/client` are two entry points backed by the same module state — and what leaves its internal cycles for the bundler to resolve rather than the hasher, which cannot order them.
3. Its dependencies are discovered and bundled too, recursively, so managing one package implicitly manages its whole import subgraph (e.g. `vue` pulls in `@vue/*`). Shared dependencies become their own chunks rather than being duplicated, which also preserves singletons like `@vue/reactivity`.
4. Chunks are hashed **bottom-up**: each chunk imports its dependencies by their content hash (`cos:<sha256>`), so a chunk can only be hashed once its dependencies are. Two kinds of edge take part: a chunk's imports of sibling chunks in the same package, and its imports of an entry chunk in another package. The result is purely a function of the source plus a pinned build recipe.
5. Only the chunks the app can actually reach are emitted. Entry points built solely to keep the split deterministic (`svelte/compiler`, say) cost build time but ship nothing.
6. A runtime loader is injected. It looks each managed chunk up in COS by hash, falling back to the network and storing the fetched chunk for next time, then wires everything together through an import map.

The entry set in step 1 comes from the package's own `exports`, never from what the app happened to import. That is what makes a chunk's bytes a function of the package alone: two sites importing different subsets of a package still produce byte-identical chunks for whatever they have in common, and so still share them.

The `cos:` prefix is a **namespace, not a version**. It is only ever an import map key: it never reaches COS, which is keyed by the hash alone, and the loader treats it as opaque. Chunks are still only byte-identical across builds using the same recipe (the same `rolldown` version and options), but a recipe change expresses itself as different bytes and therefore a different hash, so there is nothing for the specifier to announce.

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

## Trying it out

The plugin only runs at build time, so verify against a production build, not the dev server:

```bash
vite build && vite preview
```

Then check, in your `dist/<assetsDir>/`, that the managed packages are emitted as content-hashed chunks (a 64-character hex filename like `a1b2c3...e4f5.js`), and that opening the preview URL still loads the app normally. The chunks import each other by `cos:<hash>` specifiers, resolved at runtime through an injected `<script type="importmap">`.

Without a COS-capable browser the loader fetches each chunk over the network, so this is the network-fallback path: it confirms the chunking and loader work, but not sharing.

To see real Cross-Origin Storage, install the [extension](https://chromewebstore.google.com/detail/cross-origin-storage/denpnpcgjgikjpoglpjefakmdcbmlgih), then:

1. Open the preview URL. On the first load the chunks are fetched and stored in COS (the extension's toolbar popup shows the activity).
2. Reload, or open a **different** site that ships the same dependency at the same version. In DevTools -> Network, the managed hashed `.js` chunks are no longer fetched; they come from the shared store instead.

For local testing it's safest to load the extension unpacked from [`web-ai-community/cross-origin-storage-extension`](https://github.com/web-ai-community/cross-origin-storage-extension).

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
- **Determinism is recipe-scoped.** Sharing only happens between builds on the same package version *and* the same build recipe (the same `rolldown` version and options). A recipe change yields different bytes and so a different hash: sharing lapses for those chunks, nothing breaks.
- **Every declared entry point is built,** including ones the app never imports, since the split has to be a function of the package rather than of the app. Unreachable chunks are not emitted, but they are still bundled, so managing a package with a large unused entry point (`svelte/compiler`) costs build time.
- **A cycle *between* packages is still rejected.** Cycles inside a package are now resolved by the bundler, but two packages that import each other cannot be hashed bottom-up and fail with a clear error.
- **Deep imports past `exports` are app-dependent.** A legacy package with no `exports` map, imported by a path it does not declare, has that path added as an entry point, which makes its split depend on the importing app and reduces sharing.

## Credits

Original plugin and the COS loader / import-rewriting approach by [Thomas Steiner](https://github.com/tomayac) ([`tomayac/vite-plugin-cross-origin-storage`](https://github.com/tomayac/vite-plugin-cross-origin-storage)).

## License

MIT

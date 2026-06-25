# nuxt-cos

> [!WARNING]
> Experimental. The [Cross-Origin Storage API](https://github.com/WICG/cross-origin-storage) is an early-stage proposal with no native browser support yet, and the chunk format here is not stable. This is a research project, not a production tool.

Load shared dependencies (such as `vue`) from [Cross-Origin Storage (COS)](https://github.com/WICG/cross-origin-storage).

Most sites ship their own copy of common dependencies, and the browser re-downloads them per origin even though the bytes are identical. COS lets a browser keep one shared, content-addressed copy. This project extracts those dependencies into chunks whose filename and inter-chunk references are derived from a SHA-256 of their contents, so two independent sites building the same dependency at the same version produce the same chunk and can share it, with no central registry.

## Packages

| Package                                                                           | Description                                                                                  |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`vite-plugin-cross-origin-storage`](./packages/vite-plugin-cross-origin-storage) | The core Vite plugin: content-addressed chunking, bottom-up hashing, and the runtime loader. |
| [`nuxt-cos`](./packages/nuxt-cos)                                                 | A thin Nuxt module wrapping the plugin.                                                      |

## Status

This is exploratory. The Cross-Origin Storage API is a [WICG proposal](https://github.com/WICG/cross-origin-storage) with no native browser implementation; today it only works via the [browser extension](https://github.com/web-ai-community/cross-origin-storage-extension). Without COS the loader falls back to ordinary network requests, so builds keep working everywhere.

The plugin builds on [Thomas Steiner](https://github.com/tomayac)'s original [`vite-plugin-cross-origin-storage`](https://github.com/tomayac/vite-plugin-cross-origin-storage) and is intended as an update of it, with the aim of merging back upstream.

## 🚧 Roadmap

- [ ] **Multi-entry / multi-page builds.**
- [ ] **Opting transitive dependencies out of COS chunking**.

## Development

```bash
pnpm install
pnpm build      # build all packages
pnpm test       # run unit + e2e tests
pnpm lint
```

The e2e tests will run a real browser with and without the [Cross-Origin Storage extension](https://chromewebstore.google.com/detail/cross-origin-storage/denpnpcgjgikjpoglpjefakmdcbmlgih). The COS-extension tests need a full Chrome for Testing build (`npx playwright-core install chromium`) and clone the extension at test time; set `COS_SKIP_EXTENSION_TEST=1` only in an environment that genuinely cannot run a headed browser.

## License

[MIT](./LICENSE)

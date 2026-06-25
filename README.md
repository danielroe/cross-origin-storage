# nuxt-cos

> [!WARNING]
> **Experimental**. The [Cross-Origin Storage API](https://github.com/WICG/cross-origin-storage) is an early-stage proposal with no native browser support yet, and the chunk format here is not stable.

Load shared dependencies (such as `vue`) from [Cross-Origin Storage (COS)](https://github.com/WICG/cross-origin-storage).

Most sites ship their own copy of common dependencies, and the browser re-downloads them per origin even though the bytes are identical. COS lets a browser keep one shared, content-addressed copy. This project extracts those dependencies into chunks whose filename and inter-chunk references are derived from a SHA-256 of their contents, so two independent sites building the same dependency at the same version produce the same chunk and can share it, with no central registry.

## Packages

| Package                                                                           | Description                                                                                  |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`vite-plugin-cross-origin-storage`](./packages/vite-plugin-cross-origin-storage) | The core Vite plugin: content-addressed chunking, bottom-up hashing, and the runtime loader. |
| [`nuxt-cos`](./packages/nuxt-cos)                                                 | A thin Nuxt module wrapping the plugin.                                                      |

## Status

This is exploratory. The Cross-Origin Storage API is a [WICG proposal](https://github.com/WICG/cross-origin-storage) with no native browser implementation; today it only works via the [browser extension](https://github.com/web-ai-community/cross-origin-storage-extension). Without COS the loader falls back to ordinary network requests, so builds keep working everywhere.

The idea is that this enables testing and early feedback for the proposal.

The plugin builds on [Thomas Steiner](https://github.com/tomayac)'s original [`vite-plugin-cross-origin-storage`](https://github.com/tomayac/vite-plugin-cross-origin-storage) and is intended as an update of it, with the aim of merging back upstream.

## 🚧 Roadmap

- [ ] Multi-entry / multi-page builds.
- [ ] Opting transitive dependencies out of COS chunking.
- [ ] Automatic detection of [allow-listed dependencies](https://github.com/tomayac/public-hash-list).

## License

Made with ❤️

Published under [MIT License](./LICENSE).

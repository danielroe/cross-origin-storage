# nuxt-cos

> [!WARNING]
> Experimental. The [Cross-Origin Storage API](https://github.com/WICG/cross-origin-storage) is an early-stage proposal with no native browser support yet, and the underlying chunk format is not stable. Do not depend on it in production.

A Nuxt module that loads shared dependencies (such as `vue`) from [Cross-Origin Storage (COS)](https://github.com/WICG/cross-origin-storage). It extracts those dependencies into content-addressed chunks so that a COS-capable browser can reuse the same chunk across different sites instead of downloading it once per origin.

It is a thin Nuxt wrapper around [`vite-plugin-cross-origin-storage`](https://github.com/danielroe/nuxt-cos/tree/main/packages/vite-plugin-cross-origin-storage); see that package for how the content addressing and sharing work.

## Setup

```bash
npx nuxt module add nuxt-cos
```

Or add it manually:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nuxt-cos'],
})
```

By default it manages `vue` and `@vue/*`. The module only runs in production builds (it is a no-op in dev), and it injects the COS loader into the server-rendered HTML, replacing Nuxt's default entry script.

## Configuration

```ts
export default defineNuxtConfig({
  modules: ['nuxt-cos'],
  cos: {
    // Packages to extract into COS chunks. Matched against the imported
    // specifier; a plain string is an exact match. Transitive dependencies
    // are collected automatically.
    packages: [/^(?:vue$|@vue\/)/],
  },
})
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `packages` | `Array<string \| RegExp>` | `[/^(?:vue$\|@vue\/)/]` | Packages to extract into COS chunks. |

## Browser support

The [Cross-Origin Storage API](https://github.com/WICG/cross-origin-storage) is not yet in any browser. You can try it with the [Cross-Origin Storage browser extension](https://github.com/web-ai-community/cross-origin-storage-extension). Without it, chunks load over the network as usual, so your site keeps working; it just doesn't share them.

## License

MIT

# nuxt-cos

> [!WARNING]
> Experimental. The [Cross-Origin Storage API](https://github.com/WICG/cross-origin-storage) is an early-stage proposal with no native browser support yet, and the underlying chunk format is not stable. Do not depend on it in production.

A Nuxt module that loads shared dependencies (such as `vue`) from [Cross-Origin Storage (COS)](https://github.com/WICG/cross-origin-storage). It extracts those dependencies into content-addressed chunks so that a COS-capable browser can reuse the same chunk across different sites instead of downloading it once per origin.

It is a thin Nuxt wrapper around [`vite-plugin-cross-origin-storage`](https://github.com/danielroe/cross-origin-storage/tree/main/packages/vite-plugin-cross-origin-storage); see that package for how the content addressing and sharing work.

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
| `share` | `'*' \| 'same-site' \| string[] \| (name) => …` | `'*'` | Who may read the chunks once stored. See [Sharing](https://github.com/danielroe/cross-origin-storage/tree/main/packages/vite-plugin-cross-origin-storage#sharing). For a list of origins, the module also sends the `Cross-Origin-Storage-Allow-Origin` header the pages need (see below). |

## Sharing with a list of origins

When `share` lists origins, the pages that run the COS loader must send a `Cross-Origin-Storage-Allow-Origin` response header listing those origins. Without it, the browser drops them and stores the chunks same-site only. The module sends the header for you:

- **Server-rendered pages** get it from the module's Nitro plugin, for every `share`, including a function.
- **A static list** is also added to `routeRules` for `/**`, which Nitro's static hosting presets (Netlify, Vercel, Cloudflare, and others) turn into their host's header config. This covers prerendered pages and `nuxt generate`.
- **A `share` function with prerendered pages or `nuxt generate`** is only resolved during the build, too late for `routeRules`. Configure the header on your host yourself.

A `Cross-Origin-Storage-Allow-Origin` header your app already sets, for example through `routeRules`, takes precedence.

## Trying it out

The module is a no-op in dev, so test a production build:

```bash
nuxt build && nuxt preview
```

What to look for:

- In `.output/public/_nuxt/`, the managed packages are emitted as content-hashed chunks (64-character hex filenames like `a1b2c3...e4f5.js`).
- View source on the rendered page: Nuxt's default entry `<script type="module">` is gone, replaced by a `<script id="cos-loader">` containing the loader and an inlined manifest.
- The page still hydrates and is interactive.

Without a COS-capable browser the loader fetches each chunk over the network (the fallback path), so this confirms the chunking and loader work, but not sharing.

To see real Cross-Origin Storage, install the [extension](https://chromewebstore.google.com/detail/cross-origin-storage/denpnpcgjgikjpoglpjefakmdcbmlgih), open the preview URL once (the chunks are fetched and stored), then reload or open another site shipping the same Vue version: in DevTools -> Network the hashed chunks are served from the shared store instead of refetched.

For local testing it's safest to load the extension unpacked from [`web-ai-community/cross-origin-storage-extension`](https://github.com/web-ai-community/cross-origin-storage-extension).

## Browser support

The [Cross-Origin Storage API](https://github.com/WICG/cross-origin-storage) is not yet in any browser. You can try it with the [Cross-Origin Storage browser extension](https://github.com/web-ai-community/cross-origin-storage-extension). Without it, chunks load over the network as usual, so your site keeps working; it just doesn't share them.

## License

MIT

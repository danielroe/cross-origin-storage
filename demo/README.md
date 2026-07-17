# nuxt-cos-demo

A minimal Nuxt site that uses the two packages in this monorepo from the local workspace (`workspace:*`), no published versions required:

- [`nuxt-cos`](../packages/nuxt-cos) — added as a module in [`nuxt.config.ts`](./nuxt.config.ts).
- [`vite-plugin-cross-origin-storage`](../packages/vite-plugin-cross-origin-storage) — used internally by `nuxt-cos` to do the actual chunking.

## Setup

From the monorepo root, build the two packages once so their `dist/` output exists:

```bash
pnpm --filter vite-plugin-cross-origin-storage build
pnpm --filter nuxt-cos build
```

Then, from this directory:

```bash
pnpm dev
```

Note the module is a no-op in dev, so `pnpm dev` just runs a normal Nuxt app. To see Cross-Origin Storage chunking, build and preview instead:

```bash
pnpm build
pnpm preview
```

What to look for:

- `.output/public/_nuxt/` contains the managed packages (`vue`, `@vue/*`) as content-hashed chunks (64-character hex filenames).
- View source on the page: Nuxt's default entry `<script type="module">` is replaced by a `<script id="cos-loader">` containing the loader and an inlined manifest of `cos1:<hash>` chunk references.
- The page still server-renders and hydrates normally.

Without a COS-capable browser, the loader falls back to fetching each chunk over the network, so this confirms the chunking and loader work end-to-end, but not the cross-origin sharing itself. For that, see the [nuxt-cos README](../packages/nuxt-cos/README.md#trying-it-out).

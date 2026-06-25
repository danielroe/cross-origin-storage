import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/loader.entry.ts'],
  format: ['es'],
  dts: true,
  // The loader entry is bundled by the plugin at build time via rolldown, so it
  // must be emitted as a standalone file rather than inlined into the plugin.
  unbundle: true,
})

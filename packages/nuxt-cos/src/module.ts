import { defineNuxtModule, addServerPlugin, addVitePlugin, createResolver } from '@nuxt/kit'
import { cosPlugin } from 'vite-plugin-cross-origin-storage'

export interface ModuleOptions {
  /**
   * Packages to extract into standalone Cross-Origin Storage chunks.
   * Each entry is matched against the imported module specifier; a plain
   * string is treated as an exact match.
   */
  packages: Array<string | RegExp>
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nuxt-cos',
    configKey: 'cos',
  },
  defaults: {
    packages: [/^(?:vue$|@vue\/)/],
  },
  setup(options, nuxt) {
    if (nuxt.options.dev) {
      return
    }

    const resolver = createResolver(import.meta.url)

    let scriptContent = ''

    nuxt.options.nitro.virtual ||= {}
    nuxt.options.nitro.virtual['virtual:cos-loader'] = () => `export default ${JSON.stringify(scriptContent)}`

    addServerPlugin(resolver.resolve('./runtime/server/plugins/inject'))

    addVitePlugin(() => cosPlugin({
      packages: options.packages,
      base: '/_nuxt/',
      chunkAssetsDir: '_nuxt',
      onGenerated: (content) => {
        scriptContent = content
      },
    }), { client: true, server: false })
  },
})

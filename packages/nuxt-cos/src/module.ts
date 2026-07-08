import { defineNuxtModule, addServerPlugin, addVitePlugin, createResolver } from '@nuxt/kit'
import { cosPlugin } from 'vite-plugin-cross-origin-storage'
import { resolveBuildAssetsBase } from './runtime/utils/assets-base'

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

    addVitePlugin(() => {
      const assetsBase = resolveBuildAssetsBase(nuxt.options.app)
      return cosPlugin({
        packages: options.packages,
        base: assetsBase,
        onGenerated: (content) => {
          scriptContent = content
        },
      })
    }, { client: true, server: false })
  },
})

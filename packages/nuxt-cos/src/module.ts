import { defineNuxtModule, addServerPlugin, addVitePlugin, createResolver, extendRouteRules } from '@nuxt/kit'
import { cosHeaders, cosPlugin } from 'vite-plugin-cross-origin-storage'
import type { CosPluginOptions } from 'vite-plugin-cross-origin-storage'
import { resolveBuildAssetsBase } from './runtime/utils/assets-base'

export interface ModuleOptions {
  /**
   * Packages to extract into standalone Cross-Origin Storage chunks.
   * Each entry is matched against the imported module specifier; a plain
   * string is treated as an exact match.
   */
  packages: Array<string | RegExp>
  /**
   * Who may read the managed chunks once they are stored: every origin (`'*'`, the default), only
   * same-site origins (`'same-site'`), a list of origins, or a function that picks per package.
   * See `vite-plugin-cross-origin-storage`.
   */
  share?: CosPluginOptions['share']
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
    let headers: Record<string, string> = {}

    nuxt.options.nitro.virtual ||= {}
    nuxt.options.nitro.virtual['virtual:cos-loader'] = () => `export default ${JSON.stringify(scriptContent)}\nexport const headers = ${JSON.stringify(headers)}`

    // Prerendered pages are served without Nitro rendering them, so headers that are known up
    // front also go into the route rules, which static presets turn into their host's header
    // config. A `share` function is only resolved during the build, too late for route rules.
    if (typeof options.share !== 'function') {
      const staticHeaders = cosHeaders([options.share])
      if (Object.keys(staticHeaders).length) {
        extendRouteRules('/**', { headers: staticHeaders })
      }
    }

    addServerPlugin(resolver.resolve('./runtime/server/plugins/inject'))

    addVitePlugin(() => {
      const assetsBase = resolveBuildAssetsBase(nuxt.options.app)
      return cosPlugin({
        packages: options.packages,
        ...options.share !== undefined ? { share: options.share } : {},
        base: assetsBase,
        onGenerated: (content, page) => {
          scriptContent = content
          headers = page.headers
        },
      })
    }, { client: true, server: false })
  },
})

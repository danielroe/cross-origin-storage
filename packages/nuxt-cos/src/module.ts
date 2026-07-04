import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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

    nuxt.hook('nitro:build:public-assets', ({ options: { output, publicAssets } }) => {
      const nuxtAssets = publicAssets.find(asset => asset.baseURL === '/_nuxt')
      if (!nuxtAssets?.dir) {
        return
      }

      const cosAssetsDir = join(nuxtAssets.dir, '..', 'assets')
      if (!existsSync(cosAssetsDir)) {
        return
      }

      const cosChunks = readdirSync(cosAssetsDir).filter(file => /^[a-f0-9]{64}\.js$/.test(file))
      if (!cosChunks.length) {
        return
      }

      const publicNuxtDir = join(output.publicDir, '_nuxt')
      mkdirSync(publicNuxtDir, { recursive: true })
      for (const file of cosChunks) {
        copyFileSync(join(cosAssetsDir, file), join(publicNuxtDir, file))
      }
    })

    addVitePlugin(() => cosPlugin({
      packages: options.packages,
      base: '/_nuxt/',
      onGenerated: (content) => {
        scriptContent = content
      },
    }), { client: true, server: false })
  },
})

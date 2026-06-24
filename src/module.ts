import { createHash } from 'node:crypto'
import { defineNuxtModule, addServerPlugin, addVitePlugin, createResolver } from '@nuxt/kit'
import { rolldown } from 'rolldown'
import { runCosLoader } from './runtime/loader'
import type { CosManifest } from './runtime/loader'

export interface ModuleOptions {
  /**
   * Packages to extract into standalone Cross-Origin Storage chunks.
   * Each entry is matched against the imported module specifier; a plain
   * string is treated as an exact match.
   */
  packages: Array<string | RegExp>
}

interface CollectedPackage {
  /** Bare specifiers this package is imported under (e.g. `vue`, `@vue/runtime-dom`). */
  specifiers: Set<string>
  /** Output chunk basename, e.g. `vue` -> emitted as `_nuxt/vue.js`. */
  chunk: string
}

function bareSpecifier(chunk: string): string {
  return `coschunk-${chunk}`
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
    const packages = options.packages.map(p => typeof p === 'string' ? new RegExp(`^${p}$`) : p)

    let scriptContent = ''

    nuxt.options.nitro.virtual ||= {}
    nuxt.options.nitro.virtual['virtual:cos-loader'] = () => `export default ${JSON.stringify(scriptContent)}`

    addServerPlugin(resolver.resolve('./runtime/server/plugins/inject'))

    const collected = new Map<string, CollectedPackage>()
    const usedChunkNames = new Set<string>()

    function chunkNameFor(specifier: string): string {
      let index = 0
      let name: string
      do {
        name = (specifier + (index ? `-${index}` : '')).replace(/[^a-z0-9]/gi, '-').replace(/(^-+)|(-+$)/g, '')
        index++
      } while (usedChunkNames.has(name))
      usedChunkNames.add(name)
      return name
    }

    addVitePlugin(() => ({
      name: 'nuxt-cos',
      enforce: 'pre',
      resolveId: {
        order: 'pre',
        async handler(id, importer, resolveOptions) {
          if (!packages.some(p => p.test(id))) {
            return
          }

          const resolved = await this.resolve(id, importer, { ...resolveOptions, skipSelf: true })
          if (!resolved) {
            return
          }

          let pkg = collected.get(resolved.id)
          if (!pkg) {
            pkg = { specifiers: new Set(), chunk: chunkNameFor(id) }
            collected.set(resolved.id, pkg)
          }
          pkg.specifiers.add(id)

          return { id: bareSpecifier(pkg.chunk), external: true }
        },
      },
      async generateBundle(_outputOptions, bundle) {
        const externalIds = [...collected.keys()]
        // Map every bare specifier any managed package may emit to its chunk.
        const specifierToChunk = new Map<string, string>()
        for (const pkg of collected.values()) {
          for (const specifier of pkg.specifiers) {
            specifierToChunk.set(specifier, pkg.chunk)
          }
        }

        const managed: CosManifest['chunks'] = {}

        for (const [input, pkg] of collected) {
          const builder = await rolldown({
            input,
            platform: 'browser',
            treeshake: false,
            external: externalIds.filter(id => id !== input),
          })
          const { output } = await builder.generate({ file: `${pkg.chunk}.js`, codeSplitting: false })
          await builder.close()

          let code = output[0].code
          for (const [specifier, chunk] of specifierToChunk) {
            code = rewriteSpecifier(code, specifier, bareSpecifier(chunk))
          }
          // Imports rolldown kept as resolved absolute paths to other managed packages.
          for (const otherId of externalIds) {
            const chunk = collected.get(otherId)!.chunk
            code = rewriteSpecifier(code, otherId, bareSpecifier(chunk))
          }

          const fileName = `_nuxt/${pkg.chunk}.js`
          const hash = createHash('sha256').update(code).digest('hex')
          managed[bareSpecifier(pkg.chunk)] = { file: `${pkg.chunk}.js`, hash }
          bundle[fileName] = {
            type: 'asset',
            fileName,
            name: pkg.chunk,
            names: [pkg.chunk],
            originalFileName: null,
            originalFileNames: [],
            needsCodeReference: false,
            source: code,
          }
        }

        let entry: string | undefined
        for (const file of Object.values(bundle)) {
          if (file.type !== 'chunk') {
            continue
          }
          for (const [specifier, chunk] of specifierToChunk) {
            file.code = rewriteSpecifier(file.code, specifier, bareSpecifier(chunk))
          }
          if (file.isEntry) {
            entry = bareSpecifier(file.fileName)
            managed[bareSpecifier(file.fileName)] ??= {
              file: file.fileName.replace(/^_nuxt\//, ''),
              hash: createHash('sha256').update(file.code).digest('hex'),
            }
          }
        }

        if (!entry) {
          return
        }

        const manifest: CosManifest = { base: '/_nuxt/', entry, chunks: managed }
        scriptContent = `(${runCosLoader.toString()})(${JSON.stringify(manifest)})`
      },
    }), { client: true, server: false })
  },
})

function rewriteSpecifier(code: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const fromImport = new RegExp(`((?:import|export)\\b[^;'"\\n]*?from\\s*|import\\s*|export\\s*\\*\\s*from\\s*)(["'])${escaped}\\2`, 'g')
  const bareImport = new RegExp(`(\\bimport\\s*)(["'])${escaped}\\2`, 'g')
  const dynamic = new RegExp(`(\\bimport\\s*\\(\\s*)(["'])${escaped}\\2(\\s*\\))`, 'g')
  return code
    .replace(dynamic, `$1$2${to}$2$3`)
    .replace(fromImport, `$1$2${to}$2`)
    .replace(bareImport, `$1$2${to}$2`)
}

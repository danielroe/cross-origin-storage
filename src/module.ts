import { createHash } from 'node:crypto'
import { defineNuxtModule, addServerPlugin, addVitePlugin, createResolver } from '@nuxt/kit'
import { rolldown } from 'rolldown'
import type { CosManifest } from './runtime/loader'

const MANIFEST_PLACEHOLDER = '__COS_MANIFEST__'

/**
 * Bundle the runtime loader into a self-contained IIFE with rolldown, leaving
 * `__COS_MANIFEST__` as a literal token for the caller to substitute.
 */
async function bundleLoader(entry: string): Promise<string> {
  const builder = await rolldown({ input: entry, platform: 'browser', treeshake: true })
  const { output } = await builder.generate({ format: 'iife', minify: true })
  await builder.close()
  return output[0].code
}

export interface ModuleOptions {
  /**
   * Packages to extract into standalone Cross-Origin Storage chunks.
   * Each entry is matched against the imported module specifier; a plain
   * string is treated as an exact match.
   */
  packages: Array<string | RegExp>
}

/**
 * Recipe version embedded in every content-addressed specifier, meant to be bumped
 * whenever the build recipe (bundler version, options, define replacements)
 * changes in a way that alters emitted bytes, so chunks built under different
 * recipes cannot silently collide on the same SHA-256.
 */
const RECIPE = 'cos1'

function contentSpecifier(hash: string): string {
  return `${RECIPE}:${hash}`
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

    const loaderEntry = resolver.resolve('./runtime/loader.entry')
    let loaderTemplate: Promise<string> | undefined
    let scriptContent = ''

    nuxt.options.nitro.virtual ||= {}
    nuxt.options.nitro.virtual['virtual:cos-loader'] = () => `export default ${JSON.stringify(scriptContent)}`

    addServerPlugin(resolver.resolve('./runtime/server/plugins/inject'))

    const collected = new Set<string>()

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

          collected.add(resolved.id)

          // Externalise under a synthetic specifier so it never clashes with the
          // real module id elsewhere in the app graph. It is rewritten to a
          // content-addressed specifier in `generateBundle`, once every managed
          // chunk has been hashed bottom-up.
          return { id: `cos-ext:${resolved.id}`, external: true }
        },
      },
      async generateBundle(_outputOptions, bundle) {
        const ids = [...collected]
        const idSet = new Set(ids)

        // Build each managed package once, externalising its siblings. The raw
        // output keeps sibling imports as their resolved absolute ids, which
        // double as the dependency edges between managed chunks.
        const raw = new Map<string, { code: string, deps: string[] }>()
        for (const input of ids) {
          const builder = await rolldown({
            input,
            platform: 'browser',
            treeshake: false,
            external: ids.filter(id => id !== input),
          })
          const { output } = await builder.generate({ file: 'chunk.js', codeSplitting: false, minify: true })
          await builder.close()

          const code = output[0].code
          const deps = [...new Set([...code.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map(m => m[1]!))]
            .filter(spec => idSet.has(spec))
          raw.set(input, { code, deps })
        }

        // Hash bottom-up: a chunk's specifier for a dependency is that
        // dependency's content hash, so a chunk can only be hashed once all of
        // its dependencies have been. The npm graph for these packages is a DAG.
        const hashes = new Map<string, string>()
        const managed: CosManifest['chunks'] = {}

        const visit = (id: string, stack: string[]): string => {
          const existing = hashes.get(id)
          if (existing) {
            return existing
          }
          if (stack.includes(id)) {
            throw new Error(`[nuxt-cos] dependency cycle between managed packages: ${[...stack, id].join(' -> ')}`)
          }

          const { code, deps } = raw.get(id)!
          let resolved = code
          for (const dep of deps) {
            resolved = rewriteSpecifier(resolved, dep, contentSpecifier(visit(dep, [...stack, id])))
          }

          const hash = createHash('sha256').update(resolved).digest('hex')
          const fileName = `_nuxt/${hash}.js`
          hashes.set(id, hash)
          managed[contentSpecifier(hash)] = { file: `${hash}.js`, hash }
          bundle[fileName] = {
            type: 'asset',
            fileName,
            name: hash,
            names: [hash],
            originalFileName: null,
            originalFileNames: [],
            needsCodeReference: false,
            source: resolved,
          }
          return hash
        }

        for (const id of ids) {
          visit(id, [])
        }

        let entry: CosManifest['entry'] | undefined
        for (const file of Object.values(bundle)) {
          if (file.type !== 'chunk') {
            continue
          }
          for (const id of ids) {
            file.code = rewriteSpecifier(file.code, `cos-ext:${id}`, contentSpecifier(hashes.get(id)!))
          }
          if (file.isEntry) {
            // the entry is app-specific and should not be content-addressed
            entry = { specifier: `${RECIPE}:entry`, file: file.fileName.replace(/^_nuxt\//, '') }
          }
        }

        if (!entry) {
          return
        }

        const manifest: CosManifest = { base: '/_nuxt/', entry, chunks: managed }
        loaderTemplate ??= bundleLoader(loaderEntry)
        scriptContent = (await loaderTemplate).replace(MANIFEST_PLACEHOLDER, JSON.stringify(manifest))
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

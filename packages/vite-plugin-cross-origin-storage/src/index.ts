import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import MagicString from 'magic-string'
import { rolldown } from 'rolldown'
import { parseAst } from 'rolldown/parseAst'
import type { Plugin } from 'vite'
import type { SourceMap } from 'rolldown'
import type { CosManifest } from './loader'

export type { CosManifest }

const MANIFEST_PLACEHOLDER = '__COS_MANIFEST__'

/**
 * Recipe version embedded in every content-addressed specifier. Bump this
 * whenever the build recipe (bundler version, options, define replacements)
 * changes in a way that alters emitted bytes, so chunks built under different
 * recipes cannot silently collide on the same SHA-256.
 */
const RECIPE = 'cos1'

// Resolve the loader entry next to this module: `.mjs` when built (dist),
// `.ts` when run from source (tests). The plugin rolldown-bundles whichever
// exists into the injected `<script>`.
function defaultLoaderEntry(): string {
  for (const ext of ['mjs', 'ts']) {
    const candidate = fileURLToPath(new URL(`./loader.entry.${ext}`, import.meta.url))
    if (existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error('[cos] could not locate the runtime loader entry')
}

export interface CosPluginOptions {
  /**
   * Packages to extract into standalone Cross-Origin Storage chunks. Each entry
   * is matched against the imported module specifier; a plain string is treated
   * as an exact match.
   */
  packages: Array<string | RegExp>
  /**
   * Public base path the managed chunks are served from. Defaults to Vite's
   * resolved `base` joined with `build.assetsDir`.
   */
  base?: string
  /**
   * Path to the runtime loader entry to bundle into the injected `<script>`.
   * Defaults to the bundled loader. Override only to swap the loader runtime.
   */
  loaderEntry?: string
  /**
   * Called once the managed chunks are emitted, with the loader `<script>` body
   * (loader IIFE + inlined manifest). SSR frameworks should inject this into
   * their rendered HTML themselves. When omitted, the plugin injects it into
   * `index.html` via `transformIndexHtml` for plain client builds.
   */
  onGenerated?: (scriptContent: string) => void
}

function contentSpecifier(hash: string): string {
  return `${RECIPE}:${hash}`
}

function toMatchers(packages: Array<string | RegExp>): RegExp[] {
  return packages.map(p => typeof p === 'string' ? new RegExp(`^${p}$`) : p)
}

/**
 * Bundle the runtime loader into a self-contained IIFE with rolldown, leaving
 * `__COS_MANIFEST__` as a literal token for the caller to substitute. Bundling
 * from source keeps the loader correct regardless of how the host build loaded
 * this plugin.
 */
async function bundleLoader(entry: string): Promise<string> {
  const builder = await rolldown({ input: entry, platform: 'browser', treeshake: true })
  const { output } = await builder.generate({ format: 'iife', minify: true })
  await builder.close()
  return output[0].code
}

interface SourceLiteral {
  value: string
  start: number
  end: number
}

/** Collect every static and dynamic import/export source string literal. */
function collectImportSources(code: string): SourceLiteral[] {
  const sources: SourceLiteral[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        visit(child)
      }
      return
    }
    const record = node as Record<string, unknown> & { type?: string }
    if (record.type === 'ImportDeclaration' || record.type === 'ExportNamedDeclaration'
      || record.type === 'ExportAllDeclaration' || record.type === 'ImportExpression') {
      const source = record.source as { type?: string, value?: unknown, start?: number, end?: number } | undefined
      if (source?.type === 'Literal' && typeof source.value === 'string'
        && typeof source.start === 'number' && typeof source.end === 'number') {
        sources.push({ value: source.value, start: source.start, end: source.end })
      }
    }
    for (const key in record) {
      if (key !== 'type') {
        visit(record[key])
      }
    }
  }
  visit(parseAst(code))
  return sources
}

/**
 * Rewrite import/export specifiers by AST position rather than by pattern, so a
 * managed specifier appearing in an ordinary string literal is never touched
 * and dynamic imports are handled the same as static ones. Returns a sourcemap
 * only when `withMap` is set (i.e. the source chunk already had one to keep
 * valid); the standalone cos chunks have no downstream map and skip it.
 */
function rewriteSpecifiers(
  code: string,
  rewrites: Map<string, string>,
  fileName: string,
  withMap: boolean,
): { code: string, map?: SourceMap } {
  const sources = collectImportSources(code)
  const edits = sources.filter(s => rewrites.has(s.value))
  if (!edits.length) {
    return { code }
  }

  const magic = new MagicString(code)
  for (const { value, start, end } of edits) {
    // start/end span the literal including its quotes; preserve the quote char.
    const quote = code[start]
    magic.overwrite(start, end, `${quote}${rewrites.get(value)!}${quote}`)
  }

  return {
    code: magic.toString(),
    map: withMap ? magic.generateMap({ source: fileName, hires: 'boundary' }) as unknown as SourceMap : undefined,
  }
}

function joinBase(base: string, assetsDir: string): string {
  const prefix = base.endsWith('/') ? base : `${base}/`
  const dir = trimSlashes(assetsDir)
  return dir ? `${prefix}${dir}/` : prefix
}

function stripPrefix(fileName: string, prefix: string): string {
  return prefix && fileName.startsWith(prefix) ? fileName.slice(prefix.length) : fileName
}

function trimSlashes(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === '/') start++
  while (end > start && value[end - 1] === '/') end--
  return value.slice(start, end)
}

export function cosPlugin(options: CosPluginOptions): Plugin {
  const packages = toMatchers(options.packages)
  const loaderEntry = options.loaderEntry ?? defaultLoaderEntry()

  const collected = new Set<string>()
  let assetsDir = 'assets'
  let resolvedBase = '/'
  let loaderTemplate: Promise<string> | undefined
  let scriptContent = ''

  return {
    name: 'vite-plugin-cos',
    enforce: 'pre',
    apply: 'build',
    configResolved(config) {
      assetsDir = config.build.assetsDir
      resolvedBase = config.base
    },
    resolveId: {
      order: 'pre',
      filter: { id: packages },
      async handler(id, importer, resolveOptions) {
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
      if (!collected.size) {
        return
      }
      const base = options.base ?? joinBase(resolvedBase, assetsDir)
      const assetPrefix = assetsDir ? `${trimSlashes(assetsDir)}/` : ''
      const basePrefix = base.startsWith('/') ? `${trimSlashes(base)}/` : ''

      // Build each managed package standalone, externalising every dependency
      // by its resolved absolute id. Transitive dependencies are discovered and
      // queued here, so managing a package implicitly manages its whole import
      // subgraph (e.g. `vue` pulls in `@vue/*`) without the app having to list
      // them. The externalised ids double as the edges between managed chunks.
      const raw = new Map<string, { code: string, deps: string[] }>()
      const queue = [...collected]
      while (queue.length) {
        const input = queue.shift()!
        if (raw.has(input)) {
          continue
        }

        const deps = new Set<string>()
        let code: string
        try {
          const builder = await rolldown({
            input,
            platform: 'browser',
            treeshake: false,
            plugins: [{
              name: 'cos-externalise-deps',
              async resolveId(id, importer) {
                if (!importer) {
                  return null
                }
                const dep = await this.resolve(id, importer, { skipSelf: true })
                if (!dep) {
                  return null
                }
                deps.add(dep.id)
                // Externalise under a synthetic specifier keyed by the resolved
                // id, so the emitted import is a literal token we rewrite later.
                // Source specifiers may be relative (`./shared/x.mjs`); the
                // token makes the rewrite independent of how they were written.
                return { id: `cos-dep:${dep.id}`, external: true }
              },
            }],
          })
          // `minify` is part of the pinned recipe (see RECIPE): it both shrinks
          // the chunk and strips rolldown's `//#region <path>` debug comments,
          // which embed cwd-relative paths and would otherwise make the hash
          // depend on the build location.
          const { output } = await builder.generate({ file: 'chunk.js', codeSplitting: false, minify: true })
          await builder.close()
          code = output[0].code
        }
        catch (error) {
          throw new Error(
            `[cos] cannot bundle managed package as a standalone chunk:\n  ${input}\n`
            + `It likely imports build-time virtuals (e.g. \`#build/*\`, \`#imports\`) that only `
            + `resolve inside the host build, so it is not a self-contained, shareable artifact. `
            + `Only depend on packages whose source resolves from disk on its own.\n\n`
            + `Underlying error: ${(error as Error).message}`,
            { cause: error },
          )
        }

        raw.set(input, { code, deps: [...deps] })
        queue.push(...deps)
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
          throw new Error(`[cos] dependency cycle between managed packages: ${[...stack, id].join(' -> ')}`)
        }

        const { code, deps } = raw.get(id)!
        // Resolve each dep's hash first (bottom-up), then rewrite in one pass.
        const rewrites = new Map<string, string>()
        for (const dep of deps) {
          rewrites.set(`cos-dep:${dep}`, contentSpecifier(visit(dep, [...stack, id])))
        }
        // Standalone cos chunks have no downstream sourcemap, so none is kept.
        const { code: resolved } = rewriteSpecifiers(code, rewrites, '', false)

        const hash = createHash('sha256').update(resolved).digest('hex')
        const fileName = `${assetPrefix}${hash}.js`
        hashes.set(id, hash)
        managed[contentSpecifier(hash)] = { file: `${hash}.js`, hash }
        this.emitFile({ type: 'asset', fileName, source: resolved })
        return hash
      }

      for (const id of raw.keys()) {
        visit(id, [])
      }

      // App chunks only reference the packages the app imported directly,
      // externalised as `cos-ext:<id>` by this plugin's `resolveId`.
      const appRewrites = new Map<string, string>()
      for (const id of collected) {
        appRewrites.set(`cos-ext:${id}`, contentSpecifier(hashes.get(id)!))
      }

      let entry: CosManifest['entry'] | undefined
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') {
          continue
        }
        // Keep the chunk's sourcemap valid when one exists (the consumer enabled
        // `build.sourcemap`); otherwise skip map generation entirely.
        const { code, map } = rewriteSpecifiers(file.code, appRewrites, file.fileName, !!file.map)
        file.code = code
        if (map) {
          file.map = map
        }
        if (file.isEntry) {
          // The entry is app-specific and is re-rendered by Vite after this
          // hook, so it cannot be content-addressed here; it loads from the
          // network under a stable specifier instead.
          entry = {
            specifier: `${RECIPE}:entry`,
            file: stripPrefix(stripPrefix(file.fileName, assetPrefix), basePrefix),
          }
        }
      }

      if (!entry) {
        return
      }

      const manifest: CosManifest = { base, entry, chunks: managed }
      loaderTemplate ??= bundleLoader(loaderEntry)
      scriptContent = (await loaderTemplate).replace(MANIFEST_PLACEHOLDER, JSON.stringify(manifest))
      options.onGenerated?.(scriptContent)
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (options.onGenerated || !scriptContent) {
          return html
        }
        return html
          .replace(/<script type="module"[^>]*src="[^"]*"[^>]*><\/script>/g, '')
          .replace('</head>', `<script id="cos-loader">${scriptContent}</script></head>`)
      },
    },
  }
}

export default cosPlugin

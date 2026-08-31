import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
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
 * Namespace every content-addressed specifier is emitted under.
 *
 * Deliberately unversioned. The specifier is a local import map key and nothing
 * more: it never reaches Cross-Origin Storage, which is keyed by the hash alone
 * (`requestFileHandle({ algorithm, value })`), and the loader treats it as
 * opaque. So a version here could not do the one thing a version suggests it
 * does. Two chunks with different bytes already have different hashes, and two
 * with identical bytes are the same chunk and are meant to share. There is also
 * no skew to negotiate: the loader and the manifest it reads are emitted
 * together by this build, so an old loader can never meet a new manifest.
 *
 * Determinism is still recipe-scoped — see the `minify` note in `buildPackage`
 * — but a recipe change expresses itself as different bytes, and therefore a
 * different hash, without needing to be announced in the specifier.
 */
const SPECIFIER_NAMESPACE = 'cos'

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
  return `${SPECIFIER_NAMESPACE}:${hash}`
}

/**
 * Absolute path of the npm package directory a resolved module id belongs to.
 *
 * This, rather than the package *name*, is what identifies a package here: two
 * copies of the same name at different versions can coexist in one graph, and
 * they must not be treated as the same chunk.
 */
function packageRootFromId(id: string): string | undefined {
  const marker = '/node_modules/'
  const index = id.lastIndexOf(marker)
  if (index === -1) {
    return undefined
  }
  const start = index + marker.length
  const [first, second] = id.slice(start).split('/')
  if (!first) {
    return undefined
  }
  const scoped = first.startsWith('@') && second
  return id.slice(0, start) + (scoped ? `${first}/${second}` : first)
}

function packageNameFromRoot(root: string): string | undefined {
  const marker = '/node_modules/'
  const index = root.lastIndexOf(marker)
  return index === -1 ? undefined : root.slice(index + marker.length)
}

/**
 * Export conditions a production browser build resolves under, in the order
 * Node applies them: the first key that matches wins.
 */
const EXPORT_CONDITIONS = ['browser', 'module', 'import', 'production', 'default']

function resolveExportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = resolveExportTarget(item)
      if (target) {
        return target
      }
    }
    return undefined
  }
  if (value && typeof value === 'object') {
    for (const [condition, nested] of Object.entries(value as Record<string, unknown>)) {
      if (EXPORT_CONDITIONS.includes(condition)) {
        const target = resolveExportTarget(nested)
        if (target) {
          return target
        }
      }
    }
  }
  return undefined
}

/** Turn a specifier or relative path into a deterministic, filesystem-safe chunk name. */
function entryName(specifier: string): string {
  return specifier.replace(/\.[cm]?[jt]sx?$/, '').replace(/[^\w.-]+/g, '_') || 'index'
}

/**
 * Every entry point a package declares, as absolute paths keyed by a stable
 * chunk name.
 *
 * The entry set has to be a property of the package, never of the app. The
 * split between a package's chunks depends on which entry points are built
 * together, so deriving it from what the app happened to import would make two
 * sites produce different bytes for the same package and share nothing.
 *
 * The `exports` map is read directly rather than put through the host
 * resolver, so the set depends only on the package on disk. If a condition here
 * ever disagrees with how the app resolved a specifier, correctness still
 * holds: the app's own resolved ids are added as required entry points by the
 * caller. Only the split, and so the degree of sharing, would suffer.
 *
 * Wildcard subpaths are skipped, having no enumerable set of entry points; a
 * deep import through one is picked up as a required entry instead.
 */
function declaredEntryPoints(root: string): Map<string, string> {
  const entries = new Map<string, string>()
  const name = packageNameFromRoot(root)
  if (!name) {
    return entries
  }

  let manifest: { exports?: unknown, module?: unknown, main?: unknown }
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as typeof manifest
  }
  catch {
    return entries
  }

  const add = (subpath: string, target: unknown): void => {
    const file = resolveExportTarget(target)
    if (!file?.startsWith('.')) {
      return
    }
    const path = join(root, file)
    if (!existsSync(path) || entries.has(path)) {
      return
    }
    entries.set(path, entryName(subpath === '.' ? name : `${name}/${subpath.slice(2)}`))
  }

  const exports = manifest.exports
  if (exports === undefined) {
    // Legacy package: the single `module`/`main` entry is all it declares.
    const main = typeof manifest.module === 'string' ? manifest.module : manifest.main
    if (typeof main === 'string') {
      add('.', main.startsWith('.') ? main : `./${main}`)
    }
    return entries
  }

  if (typeof exports !== 'object' || exports === null || Array.isArray(exports)) {
    add('.', exports)
    return entries
  }

  const subpaths = Object.keys(exports).filter(key => key.startsWith('.'))
  if (!subpaths.length) {
    // A bare conditions object, i.e. the root export only.
    add('.', exports)
    return entries
  }

  for (const subpath of subpaths) {
    if (subpath !== './package.json' && !subpath.includes('*')) {
      add(subpath, (exports as Record<string, unknown>)[subpath])
    }
  }
  return entries
}

/** Synthetic specifier marking an import that leaves the package being built. */
const DEP_PREFIX = 'cos-dep:'

interface PackageBuild {
  /** Emitted chunk file name -> its code, before specifier rewriting. */
  chunks: Map<string, string>
  /** Resolved entry module id -> the chunk that is that entry point. */
  entryChunks: Map<string, string>
  /** Resolved module ids this package imports from other packages. */
  externalDeps: Set<string>
}

/**
 * Bundle one managed package, with every entry point it declares built together
 * and code splitting on.
 *
 * Building the entry points together is what keeps a package's singletons
 * intact: `svelte` and `svelte/internal/client` are two entry points of one
 * package backed by the same reactivity state, and bundling them apart would
 * hand the app two copies of it. Only imports that leave the package are
 * externalised, so a package that ships unbundled source becomes a handful of
 * chunks rather than one per source file, and its internal cycles are resolved
 * by rolldown instead of reaching the hasher.
 */
async function buildPackage(root: string, requiredIds: ReadonlySet<string>): Promise<PackageBuild> {
  const inputs = declaredEntryPoints(root)
  for (const id of requiredIds) {
    if (!inputs.has(id)) {
      inputs.set(id, entryName(relative(root, id)))
    }
  }
  if (!inputs.size) {
    throw new Error(`[cos] managed package declares no entry points:\n  ${root}`)
  }

  const input: Record<string, string> = {}
  for (const [path, name] of inputs) {
    let unique = name
    let attempt = 1
    while (unique in input) {
      unique = `${name}_${++attempt}`
    }
    input[unique] = path
  }

  const externalDeps = new Set<string>()
  let output: Awaited<ReturnType<Awaited<ReturnType<typeof rolldown>>['generate']>>['output']
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
          // Imports that stay inside the package are bundled. Externalising
          // them, as this once did, is what turned a source-shipping package
          // into one chunk per file and let its internal cycles reach the
          // hasher, which cannot order them.
          if (packageRootFromId(dep.id) === root) {
            return null
          }
          externalDeps.add(dep.id)
          // Externalise under a synthetic specifier keyed by the resolved id, so
          // the emitted import is a literal token we rewrite later. Source
          // specifiers may be relative; the token makes the rewrite independent
          // of how they were written.
          return { id: `${DEP_PREFIX}${dep.id}`, external: true }
        },
      }],
    })
    // `minify` is part of the pinned build recipe: it both shrinks the
    // chunk and strips rolldown's `//#region <path>` debug comments, which embed
    // cwd-relative paths and would otherwise make the hash depend on the build
    // location.
    ;({ output } = await builder.generate({
      dir: 'cos',
      format: 'es',
      minify: true,
      entryFileNames: '[name].js',
      chunkFileNames: 'shared-[hash].js',
    }))
    await builder.close()
  }
  catch (error) {
    throw new Error(
      `[cos] cannot bundle managed package as standalone chunks:\n  ${root}\n`
      + `It likely imports build-time virtuals (e.g. \`#build/*\`, \`#imports\`) that only `
      + `resolve inside the host build, so it is not a self-contained, shareable artifact. `
      + `Only depend on packages whose source resolves from disk on its own.\n\n`
      + `Underlying error: ${(error as Error).message}`,
      { cause: error },
    )
  }

  const chunks = new Map<string, string>()
  const entryChunks = new Map<string, string>()
  for (const item of output) {
    if (item.type !== 'chunk') {
      continue
    }
    chunks.set(item.fileName, item.code)
    if (item.isEntry && item.facadeModuleId) {
      entryChunks.set(item.facadeModuleId, item.fileName)
    }
  }
  return { chunks, entryChunks, externalDeps }
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
      const source = record.source as {
        type?: string
        value?: unknown
        start?: number
        end?: number
        expressions?: unknown[]
        quasis?: Array<{ value?: { cooked?: unknown } }>
      } | undefined
      if (source?.type === 'Literal' && typeof source.value === 'string'
        && typeof source.start === 'number' && typeof source.end === 'number') {
        sources.push({ value: source.value, start: source.start, end: source.end })
      }
      else if (source?.type === 'TemplateLiteral' && source.expressions?.length === 0
        && source.quasis?.length === 1 && typeof source.quasis[0]?.value?.cooked === 'string'
        && typeof source.start === 'number' && typeof source.end === 'number') {
        sources.push({ value: source.quasis[0].value.cooked, start: source.start, end: source.end })
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
  const dir = assetsDir.replace(/^\/+|\/+$/g, '')
  return dir ? `${prefix}${dir}/` : prefix
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
      const assetPrefix = assetsDir ? `${assetsDir.replace(/^\/+|\/+$/g, '')}/` : ''

      // Build one bundle per managed *package*, not per module. Transitive
      // dependencies are discovered and queued here, so managing a package
      // implicitly manages its whole import subgraph (e.g. `vue` pulls in
      // `@vue/*`) without the app having to list them.
      const builds = new Map<string, PackageBuild>()
      const required = new Map<string, Set<string>>()

      const rootOf = (id: string): string => {
        const root = packageRootFromId(id)
        if (!root) {
          throw new Error(
            `[cos] managed module does not resolve inside a package:\n  ${id}\n`
            + `Chunks are keyed by package, so a managed module must live in a `
            + `\`node_modules\` package directory to be shareable.`,
          )
        }
        return root
      }

      /** Record an entry point a package must expose. Returns true if it is new. */
      const requireEntry = (root: string, id: string): boolean => {
        let ids = required.get(root)
        if (!ids) {
          ids = new Set()
          required.set(root, ids)
        }
        if (ids.has(id)) {
          return false
        }
        ids.add(id)
        return true
      }

      const queue: string[] = []
      for (const id of collected) {
        const root = rootOf(id)
        requireEntry(root, id)
        queue.push(root)
      }

      while (queue.length) {
        const root = queue.shift()!
        if (builds.has(root)) {
          continue
        }

        const build = await buildPackage(root, required.get(root) ?? new Set())
        builds.set(root, build)

        for (const depId of build.externalDeps) {
          const depRoot = rootOf(depId)
          const isNew = requireEntry(depRoot, depId)
          const existing = builds.get(depRoot)
          if (!existing) {
            queue.push(depRoot)
          }
          else if (isNew && !existing.entryChunks.has(depId)) {
            // Already built before this entry point was known to be needed,
            // which only happens for a legacy package with no `exports` that a
            // deep import reaches past. Rebuild it with the entry included.
            builds.delete(depRoot)
            queue.push(depRoot)
          }
        }
      }

      // Hash bottom-up over the chunk graph: a chunk references each dependency
      // by that dependency's content hash, so it can only be hashed once all of
      // them have been. Two kinds of edge take part — a chunk's imports of
      // sibling chunks in the same package, and its imports of an entry chunk in
      // another package. Package-internal cycles never appear here, having been
      // resolved into a chunk by rolldown.
      const keyOf = (root: string, file: string): string => `${root}\0${file}`
      const describe = (key: string): string => {
        const [root, file] = key.split('\0') as [string, string]
        return `${packageNameFromRoot(root) ?? root}:${file}`
      }

      const entryChunkKey = (id: string): string => {
        const root = rootOf(id)
        const file = builds.get(root)?.entryChunks.get(id)
        if (!file) {
          throw new Error(
            `[cos] no entry chunk for managed module:\n  ${id}\n`
            + `The package does not expose it as an entry point.`,
          )
        }
        return keyOf(root, file)
      }

      const hashes = new Map<string, string>()
      const managed: CosManifest['chunks'] = {}

      const visit = (key: string, stack: string[]): string => {
        const existing = hashes.get(key)
        if (existing) {
          return existing
        }
        if (stack.includes(key)) {
          throw new Error(
            `[cos] dependency cycle between managed packages: `
            + `${[...stack, key].map(describe).join(' -> ')}`,
          )
        }

        const [root, file] = key.split('\0') as [string, string]
        const code = builds.get(root)!.chunks.get(file)!

        // Resolve each dependency's hash first (bottom-up), then rewrite in one
        // pass. Sibling chunks are imported by relative file name, dependencies
        // in other packages by their `cos-dep:` token.
        const rewrites = new Map<string, string>()
        for (const { value } of collectImportSources(code)) {
          if (rewrites.has(value)) {
            continue
          }
          const target = value.startsWith(DEP_PREFIX)
            ? entryChunkKey(value.slice(DEP_PREFIX.length))
            : keyOf(root, value.replace(/^\.\//, ''))
          rewrites.set(value, contentSpecifier(visit(target, [...stack, key])))
        }
        // Standalone cos chunks have no downstream sourcemap, so none is kept.
        const { code: resolved } = rewriteSpecifiers(code, rewrites, '', false)

        const hash = createHash('sha256').update(resolved).digest('hex')
        hashes.set(key, hash)
        managed[contentSpecifier(hash)] = { file: `${hash}.js`, hash, name: packageNameFromRoot(root) }
        this.emitFile({ type: 'asset', fileName: `${assetPrefix}${hash}.js`, source: resolved })
        return hash
      }

      // Walking out from what the app actually imports is also what decides
      // which chunks are emitted. Entry points built only to keep the split
      // deterministic (`svelte/compiler`, say) are never reached, so they cost
      // build time but ship nothing.
      const appRewrites = new Map<string, string>()
      for (const id of collected) {
        appRewrites.set(`cos-ext:${id}`, contentSpecifier(visit(entryChunkKey(id), [])))
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
          entry = { specifier: `${SPECIFIER_NAMESPACE}:entry`, file: file.fileName.replace(new RegExp(`^${assetPrefix}`), '') }
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

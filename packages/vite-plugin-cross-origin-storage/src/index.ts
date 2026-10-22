import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
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
 * Version of the specifier format (`cos1:<sha256>`, `cos1:<sha256>-<n>`). Bump
 * it when the meaning of a specifier changes; a build recipe change already
 * changes every hash.
 */
const SPECIFIER_VERSION = 'cos1'

/**
 * Version of the build recipe: the `rolldown` version and options that decide a
 * chunk's bytes. It increases whenever the chunks emitted for the same source
 * change, and only in a minor release.
 */
export const RECIPE: number = 1

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
   * their rendered HTML themselves, and render any import map in the page as
   * `<script type="cos-importmap">` so the loader merges it into its own. When
   * omitted, the plugin does both in `index.html` via `transformIndexHtml` for
   * plain client builds.
   */
  onGenerated?: (scriptContent: string) => void
}

function contentSpecifier(hash: string): string {
  return `${SPECIFIER_VERSION}:${hash}`
}

const NODE_MODULES = '/node_modules/'

/**
 * The part of a resolved module id that starts at its package name
 * (`vue/dist/vue.js`), which is the same on every machine and under every
 * package manager's `node_modules` layout.
 */
function packagePathFromId(id: string): string | undefined {
  const index = id.lastIndexOf(NODE_MODULES)
  return index === -1 ? undefined : id.slice(index + NODE_MODULES.length)
}

/** Recover the npm package name from a resolved module id's `node_modules` segment. */
function packageNameFromId(id: string): string | undefined {
  const [first, second] = packagePathFromId(id)?.split('/') ?? []
  if (!first) {
    return undefined
  }
  return first.startsWith('@') && second ? `${first}/${second}` : first
}

/**
 * Tarjan's strongly connected components, emitted dependencies first: every
 * component comes after all the components it imports from.
 */
function stronglyConnectedComponents(ids: string[], depsOf: (id: string) => string[]): Array<[string, ...string[]]> {
  const index = new Map<string, number>()
  const lowLink = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: Array<[string, ...string[]]> = []

  const connect = (id: string): void => {
    index.set(id, index.size)
    lowLink.set(id, index.get(id)!)
    stack.push(id)
    onStack.add(id)
    for (const dep of depsOf(id)) {
      if (!index.has(dep)) {
        connect(dep)
        lowLink.set(id, Math.min(lowLink.get(id)!, lowLink.get(dep)!))
      }
      else if (onStack.has(dep)) {
        lowLink.set(id, Math.min(lowLink.get(id)!, index.get(dep)!))
      }
    }
    if (lowLink.get(id) === index.get(id)) {
      const component: string[] = []
      let member: string
      do {
        member = stack.pop()!
        onStack.delete(member)
        component.push(member)
      } while (member !== id)
      components.push(component as [string, ...string[]])
    }
  }

  for (const id of ids) {
    if (!index.has(id)) {
      connect(id)
    }
  }
  return components
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

type ScriptLang = 'js' | 'jsx' | 'ts' | 'tsx'

function isImportMeta(node: unknown): boolean {
  const meta = node as { type?: string, meta?: { name?: string }, property?: { name?: string } } | undefined
  return meta?.type === 'MetaProperty' && meta.meta?.name === 'import' && meta.property?.name === 'meta'
}

/** A string literal, or a template literal without expressions, with its position. */
function stringLiteral(node: unknown): SourceLiteral | undefined {
  const literal = node as {
    type?: string
    value?: unknown
    start?: number
    end?: number
    expressions?: unknown[]
    quasis?: Array<{ value?: { cooked?: unknown } }>
  } | undefined
  if (typeof literal?.start !== 'number' || typeof literal.end !== 'number') {
    return undefined
  }
  if (literal.type === 'Literal' && typeof literal.value === 'string') {
    return { value: literal.value, start: literal.start, end: literal.end }
  }
  if (literal.type === 'TemplateLiteral' && literal.expressions?.length === 0
    && literal.quasis?.length === 1 && typeof literal.quasis[0]?.value?.cooked === 'string') {
    return { value: literal.quasis[0].value.cooked, start: literal.start, end: literal.end }
  }
  return undefined
}

/**
 * Rewrite each `new URL('<relative path>', import.meta.url)` in a managed
 * module's source to `new URL(import.meta.resolve('cos-asset:<file>'))`, and
 * return the files it references. A managed chunk runs from a `blob:` URL when
 * it comes out of COS, and a relative path cannot be resolved against one; the
 * import map resolves the asset specifier instead.
 */
function rewriteAssetUrls(code: string, id: string, lang: ScriptLang): { code: string, assets: string[] } {
  const magic = new MagicString(code)
  const assets: string[] = []
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
    const record = node as Record<string, unknown> & { type?: string, start?: number, end?: number }
    const args = record.arguments as Array<Record<string, unknown>> | undefined
    if (record.type === 'NewExpression' && (record.callee as { name?: string })?.name === 'URL'
      && args?.length === 2 && isImportMeta(args[1]?.object)
      && (args[1]?.property as { name?: string })?.name === 'url') {
      const path = stringLiteral(args[0])?.value
      // Absolute URLs resolve without a base, so only relative paths need help.
      if (path && !/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(path)) {
        const file = resolve(dirname(id), path)
        if (existsSync(file) && statSync(file).isFile()) {
          assets.push(file)
          magic.overwrite(record.start!, record.end!, `new URL(import.meta.resolve(${JSON.stringify(`cos-asset:${file}`)}))`)
          return
        }
      }
    }
    for (const key in record) {
      if (key !== 'type') {
        visit(record[key])
      }
    }
  }
  visit(parseAst(code, { lang }))
  return { code: assets.length ? magic.toString() : code, assets }
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
      const source = stringLiteral(record.source)
      if (source) {
        sources.push(source)
      }
    }
    // `import.meta.resolve()` takes a specifier too; asset references use it.
    if (record.type === 'CallExpression' && isImportMeta((record.callee as Record<string, unknown>)?.object)
      && (record.callee as { property?: { name?: string } }).property?.name === 'resolve') {
      const literal = stringLiteral((record.arguments as unknown[])?.[0])
      if (literal) {
        sources.push(literal)
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

        // Another plugin in the chain can resolve the id again from a different
        // importer, which re-enters this hook and yields an externalised id.
        const target = resolved.id.startsWith('cos-ext:') ? resolved.id.slice('cos-ext:'.length) : resolved.id
        collected.add(target)

        // Externalise under a synthetic specifier so it never clashes with the
        // real module id elsewhere in the app graph. It is rewritten to a
        // content-addressed specifier in `generateBundle`, once every managed
        // chunk has been hashed bottom-up.
        return { id: `cos-ext:${target}`, external: true }
      },
    },
    async generateBundle(_outputOptions, bundle) {
      if (!collected.size) {
        return
      }
      const base = options.base ?? joinBase(resolvedBase, assetsDir)
      const assetPrefix = assetsDir ? `${assetsDir.replace(/^\/+|\/+$/g, '')}/` : ''

      // Build each managed module standalone, externalising every import by its
      // resolved absolute id. Transitive dependencies are discovered and
      // queued here, so managing a package implicitly manages its whole import
      // subgraph (e.g. `vue` pulls in `@vue/*`) without the app having to list
      // them. The externalised ids double as the edges between managed chunks.
      const raw = new Map<string, { code: string, deps: string[], assets: string[] }>()
      const queue = [...collected]
      while (queue.length) {
        const input = queue.shift()!
        if (raw.has(input)) {
          continue
        }

        const deps = new Set<string>()
        const assets = new Set<string>()
        let code: string
        try {
          const builder = await rolldown({
            input,
            platform: 'browser',
            treeshake: false,
            plugins: [{
              name: 'cos-externalise-deps',
              transform: {
                filter: { moduleType: ['js', 'jsx', 'ts', 'tsx'], code: 'import.meta.url' },
                handler(source, id, meta) {
                  const rewritten = rewriteAssetUrls(source, id, meta.moduleType as ScriptLang)
                  rewritten.assets.forEach(file => assets.add(file))
                  return rewritten.assets.length ? { code: rewritten.code } : null
                },
              },
              async resolveId(id, importer, { kind }) {
                // A `require()` cannot load an ES module chunk, so required
                // files are bundled into the chunk that requires them.
                if (!importer || (kind !== 'import-statement' && kind !== 'dynamic-import')) {
                  return null
                }
                const dep = await this.resolve(id, importer, { skipSelf: true })
                if (!dep) {
                  return null
                }
                // Virtual modules, such as the empty stand-in for a `browser`
                // field's `false`, have no package to share.
                if (dep.id.startsWith('\0')) {
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
          // `minify` both shrinks the chunk and strips rolldown's
          // `//#region <path>` debug comments, which embed cwd-relative paths
          // and would otherwise make the hash depend on the build location.
          const { output } = await builder.generate({
            file: 'chunk.js',
            codeSplitting: false,
            minify: true,
            comments: { legal: true, annotation: false, jsdoc: false },
          })
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

        raw.set(input, { code, deps: [...deps], assets: [...assets] })
        queue.push(...deps)
      }

      const assetSpecifiers = new Map<string, string>()
      const assets: NonNullable<CosManifest['assets']> = {}
      for (const file of new Set([...raw.values()].flatMap(r => r.assets))) {
        const source = readFileSync(file)
        const hash = createHash('sha256').update(source).digest('hex')
        const specifier = contentSpecifier(hash)
        assetSpecifiers.set(`cos-asset:${file}`, specifier)
        if (!assets[specifier]) {
          const fileName = `${hash}${extname(file)}`
          assets[specifier] = { file: fileName, hash, name: packageNameFromId(file) }
          this.emitFile({ type: 'asset', fileName: `${assetPrefix}${fileName}`, source })
        }
      }

      // Hash bottom-up: a chunk's specifier for a dependency is that
      // dependency's content hash, so a chunk can only be hashed once all of
      // its dependencies have been. Modules in an import cycle cannot wait for
      // each other, so a cycle is hashed as a group: its members import each
      // other as `cos1:<group hash>-<n>`, and each is still stored under its
      // own content hash.
      const specifiers = new Map<string, string>()
      const managed: CosManifest['chunks'] = {}
      const emitted = new Set<string>()

      // Standalone cos chunks have no downstream sourcemap, so none is kept.
      const rewriteDeps = (id: string, specifierOf: (dep: string) => string): string => {
        const { code, deps, assets } = raw.get(id)!
        const rewrites = new Map(deps.map(dep => [`cos-dep:${dep}`, specifierOf(dep)]))
        for (const file of assets) {
          rewrites.set(`cos-asset:${file}`, assetSpecifiers.get(`cos-asset:${file}`)!)
        }
        return rewriteSpecifiers(code, rewrites, '', false).code
      }

      const emit = (id: string, code: string, specifier?: string): void => {
        const hash = createHash('sha256').update(code).digest('hex')
        const key = specifier ?? contentSpecifier(hash)
        specifiers.set(id, key)
        managed[key] = { file: `${hash}.js`, hash, name: packageNameFromId(id), size: Buffer.byteLength(code) }
        if (!emitted.has(hash)) {
          emitted.add(hash)
          this.emitFile({ type: 'asset', fileName: `${assetPrefix}${hash}.js`, source: code })
        }
      }

      for (const component of stronglyConnectedComponents([...raw.keys()], id => raw.get(id)!.deps)) {
        const [first] = component
        if (component.length === 1 && !raw.get(first)!.deps.includes(first)) {
          emit(first, rewriteDeps(first, dep => specifiers.get(dep)!))
          continue
        }

        // Order the members by their path within their package, so each
        // member's number is the same on every machine.
        const members = component
          .map(id => [packagePathFromId(id) ?? id, id] as const)
          .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .map(([, id]) => id)
        const placeholders = new Map(members.map((id, n) => [id, `cos-cycle:${n}`]))
        const drafts = members.map(id => rewriteDeps(id, dep => specifiers.get(dep) ?? placeholders.get(dep)!))
        const group = contentSpecifier(createHash('sha256').update(JSON.stringify(drafts)).digest('hex'))
        const memberSpecifiers = new Map(members.map((_, n) => [`cos-cycle:${n}`, `${group}-${n}`]))
        members.forEach((id, n) => {
          emit(id, rewriteSpecifiers(drafts[n]!, memberSpecifiers, '', false).code, `${group}-${n}`)
        })
      }

      // App chunks only reference the packages the app imported directly,
      // externalised as `cos-ext:<id>` by this plugin's `resolveId`.
      const appRewrites = new Map<string, string>()
      for (const id of collected) {
        appRewrites.set(`cos-ext:${id}`, specifiers.get(id)!)
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
          entry = { specifier: `${SPECIFIER_VERSION}:entry`, file: file.fileName.replace(new RegExp(`^${assetPrefix}`), '') }
        }
      }

      if (!entry) {
        return
      }

      const manifest: CosManifest = { base, recipe: RECIPE, entry, chunks: managed, ...(assetSpecifiers.size ? { assets } : {}) }
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
          .replace(/(<script\s[^>]*?(?<![\w-])type=)(["']?)importmap\2(?=[\s>])/gi, '$1$2cos-importmap$2')
          .replace('</head>', `<script id="cos-loader">${scriptContent}</script></head>`)
      },
    },
  }
}

export default cosPlugin

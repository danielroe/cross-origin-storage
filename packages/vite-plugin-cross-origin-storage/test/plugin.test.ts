import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import { cosPlugin } from '../src/index'
import type { Alias } from 'vite'

// Build inside the project tree so fixtures resolve packages from the project
// node_modules rather than a detached temp dir.
const scratchRoot = fileURLToPath(new URL('./.plugin-scratch', import.meta.url))
// `.pnpm` lives in the workspace-root node_modules.
const nodeModules = fileURLToPath(new URL('../../../node_modules', import.meta.url))

function resolvePkg(glob: string): string {
  const match = globSync(glob, { cwd: nodeModules })[0]
  if (!match) {
    throw new Error(`fixture dependency not found: ${glob}`)
  }
  return join(nodeModules, match)
}

interface Built {
  outDir: string
  assetsDir: string
  cosChunks: () => string[]
  specifiersOf: (file: string) => string[]
  appChunks: () => string[]
  read: (file: string) => string
  html: () => string
}

async function buildApp(
  entry: string,
  packages: Array<string | RegExp>,
  alias: Alias[],
  options: { sourcemap?: boolean } = {},
): Promise<Built> {
  mkdirSync(scratchRoot, { recursive: true })
  const root = mkdtempSync(join(scratchRoot, 'app-'))
  const outDir = join(root, 'dist')
  const assetsDir = join(outDir, 'assets')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>',
  )
  writeFileSync(join(root, 'src/main.js'), entry)

  await build({
    root,
    logLevel: 'error',
    resolve: { alias },
    plugins: [cosPlugin({ packages })],
    build: { outDir, emptyOutDir: true, sourcemap: options.sourcemap ?? false, rollupOptions: { input: join(root, 'index.html') } },
  })

  const read = (file: string): string => readFileSync(join(assetsDir, file), 'utf8')
  const specifiers = (code: string): string[] =>
    [...new Set([...code.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map(m => m[1]!))]

  return {
    outDir,
    assetsDir,
    cosChunks: () => readdirSync(assetsDir).filter(f => /^[a-f0-9]{64}\.js$/.test(f)),
    appChunks: () => readdirSync(assetsDir).filter(f => f.endsWith('.js') && !/^[a-f0-9]{64}\.js$/.test(f)),
    read,
    specifiersOf: file => specifiers(read(file)),
    html: () => readFileSync(join(outDir, 'index.html'), 'utf8'),
  }
}

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true })
})

describe('cosPlugin with vue', () => {
  let app: Built

  beforeAll(async () => {
    app = await buildApp(
      'import { ref } from "vue"\ndocument.body.dataset.count = String(ref(0).value)\n',
      [/^(?:vue$|@vue\/)/],
      [{ find: 'vue', replacement: resolvePkg('.pnpm/vue@*/node_modules/vue/dist/vue.runtime.esm-bundler.js') }],
    )
  }, 120_000)

  it('emits content-addressed chunks whose names match their bytes', () => {
    expect(app.cosChunks().length).toBeGreaterThanOrEqual(1)
    for (const file of app.cosChunks()) {
      const hash = createHash('sha256').update(readFileSync(join(app.assetsDir, file))).digest('hex')
      expect(hash).toBe(file.replace('.js', ''))
    }
  })

  it('rewrites managed imports to content-addressed specifiers', () => {
    for (const file of app.cosChunks()) {
      for (const specifier of app.specifiersOf(file)) {
        expect(specifier).toMatch(/^cos1:[a-f0-9]{64}$/)
      }
    }
  })

  it('injects the loader into index.html and removes the default entry script', () => {
    const html = app.html()
    expect(html).toContain('<script id="cos-loader">')
    expect(html).toMatch(/cos1:[a-f0-9]{64}/)
    expect(html).not.toMatch(/<script type="module"[^>]*src="[^"]*\.js"/)
  })

  it('derives the base path from the vite config', () => {
    expect(app.html()).toMatch(/"base":"\/assets\/"/)
  })
})

describe('cosPlugin with a non-vue package graph (unhead + hookable)', () => {
  let app: Built

  beforeAll(async () => {
    // unhead imports hookable transitively; managing only `unhead` should still
    // externalise hookable into its own shared chunk via auto-collection,
    // exactly as @vue/shared is for the vue graph. This proves the algorithm is
    // package-agnostic, not vue-shaped, and that transitive deps are collected.
    app = await buildApp(
      'import { createHead } from "unhead/client"\ndocument.title = String(!!createHead)\n',
      ['unhead/client'],
      [
        { find: /^unhead\/client$/, replacement: resolvePkg('.pnpm/unhead@*/node_modules/unhead/dist/client.mjs') },
        { find: /^hookable$/, replacement: resolvePkg('.pnpm/hookable@*/node_modules/hookable/dist/index.mjs') },
      ],
    )
  }, 120_000)

  it('auto-collects transitive deps the app never imported directly', () => {
    // The app imports only `unhead/client`, yet hookable (a transitive dep) and
    // unhead's internal shared chunks each become their own managed chunk.
    expect(app.cosChunks().length).toBeGreaterThan(1)
    for (const file of app.cosChunks()) {
      const hash = createHash('sha256').update(readFileSync(join(app.assetsDir, file))).digest('hex')
      expect(hash).toBe(file.replace('.js', ''))
    }
  })

  it('externalises shared deps into leaf chunks rather than inlining them', () => {
    // A leaf imports no managed chunk; if deps were inlined there would be no
    // leaves, and a chunk with deps depends on those leaves.
    const leaves = app.cosChunks().filter(f => app.specifiersOf(f).length === 0)
    expect(leaves.length).toBeGreaterThanOrEqual(1)

    const dependants = app.cosChunks().filter(f => app.specifiersOf(f).length > 0)
    expect(dependants.length).toBeGreaterThanOrEqual(1)
  })

  it('references dependencies only by content-addressed specifier', () => {
    for (const file of app.cosChunks()) {
      for (const specifier of app.specifiersOf(file)) {
        expect(specifier).toMatch(/^cos1:[a-f0-9]{64}$/)
      }
    }
  })
})

describe('cosPlugin specifier rewriting', () => {
  const vueAlias: Alias[] = [
    { find: /^vue$/, replacement: '' }, // replaced per-test below
  ]
  vueAlias[0]!.replacement = resolvePkg('.pnpm/vue@*/node_modules/vue/dist/vue.runtime.esm-bundler.js')

  it('does not rewrite a managed specifier that appears in a string literal', async () => {
    // The string "vue" is data here, not an import; AST-based rewriting must
    // leave it alone while still rewriting the real import.
    const app = await buildApp(
      'import { ref } from "vue"\nconst label = "vue"\ndocument.title = label + String(ref(0).value)\n',
      [/^(?:vue$|@vue\/)/],
      vueAlias,
    )
    const entry = app.appChunks().map(f => app.read(f)).join('\n')
    // The literal survives verbatim; the import is content-addressed.
    expect(entry).toMatch(/["']vue["']/)
    expect(entry).toMatch(/cos1:[a-f0-9]{64}/)
  }, 120_000)

  it('rewrites a dynamic import of a managed package', async () => {
    // Reference the dynamic import from a side effect so it is not tree-shaken.
    const app = await buildApp(
      'window.addEventListener("click", () => { import("vue").then(m => { document.title = String(m.ref(0).value) }) })\n',
      [/^(?:vue$|@vue\/)/],
      vueAlias,
    )
    const entry = app.appChunks().map(f => app.read(f)).join('\n')
    expect(entry).toMatch(/import\(\s*["']cos1:[a-f0-9]{64}["']\s*\)/)
  }, 120_000)

  it('keeps the chunk sourcemap valid when build.sourcemap is enabled', async () => {
    const app = await buildApp(
      'import { ref } from "vue"\ndocument.title = String(ref(0).value)\n',
      [/^(?:vue$|@vue\/)/],
      vueAlias,
      { sourcemap: true },
    )
    const rewritten = app.appChunks().find(f => app.read(f).includes('cos1:'))
    expect(rewritten, 'expected a rewritten app chunk').toBeDefined()

    const map = JSON.parse(app.read(`${rewritten}.map`))
    expect(map.version).toBe(3)
    expect(map.mappings.length).toBeGreaterThan(0)
    expect(Array.isArray(map.sources)).toBe(true)
  }, 120_000)
})

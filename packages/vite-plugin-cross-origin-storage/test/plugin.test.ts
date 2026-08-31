import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import { build as build8 } from 'vite8'
import { cosPlugin } from '../src/index'
import type { Alias } from 'vite'

type BuildFn = typeof build

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
  options: { sourcemap?: boolean, build?: BuildFn } = {},
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

  await (options.build ?? build)({
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
        expect(specifier).toMatch(/^cos:[a-f0-9]{64}$/)
      }
    }
  })

  it('injects the loader into index.html and removes the default entry script', () => {
    const html = app.html()
    expect(html).toContain('<script id="cos-loader">')
    expect(html).toMatch(/cos:[a-f0-9]{64}/)
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
        expect(specifier).toMatch(/^cos:[a-f0-9]{64}$/)
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
    expect(entry).toMatch(/["'`]vue["'`]/)
    expect(entry).toMatch(/cos:[a-f0-9]{64}/)
  }, 120_000)

  it('rewrites a dynamic import of a managed package', async () => {
    // Reference the dynamic import from a side effect so it is not tree-shaken.
    const app = await buildApp(
      'window.addEventListener("click", () => { import("vue").then(m => { document.title = String(m.ref(0).value) }) })\n',
      [/^(?:vue$|@vue\/)/],
      vueAlias,
    )
    const entry = app.appChunks().map(f => app.read(f)).join('\n')
    expect(entry).toMatch(/import\(\s*["'`]cos:[a-f0-9]{64}["'`]\s*\)/)
  }, 120_000)

  it('keeps the chunk sourcemap valid when build.sourcemap is enabled', async () => {
    const app = await buildApp(
      'import { ref } from "vue"\ndocument.title = String(ref(0).value)\n',
      [/^(?:vue$|@vue\/)/],
      vueAlias,
      { sourcemap: true },
    )
    const rewritten = app.appChunks().find(f => app.read(f).includes('cos:'))
    expect(rewritten, 'expected a rewritten app chunk').toBeDefined()

    const map = JSON.parse(app.read(`${rewritten}.map`))
    expect(map.version).toBe(3)
    expect(map.mappings.length).toBeGreaterThan(0)
    expect(Array.isArray(map.sources)).toBe(true)
  }, 120_000)
})

describe('cosPlugin under Vite 8 (rolldown)', () => {
  let app: Built

  beforeAll(async () => {
    app = await buildApp(
      'import { ref } from "vue"\ndocument.body.dataset.count = String(ref(0).value)\n',
      [/^(?:vue$|@vue\/)/],
      [{ find: 'vue', replacement: resolvePkg('.pnpm/vue@*/node_modules/vue/dist/vue.runtime.esm-bundler.js') }],
      { build: build8 as unknown as BuildFn },
    )
  }, 120_000)

  it('writes content-addressed chunks to disk', () => {
    expect(app.cosChunks().length).toBeGreaterThanOrEqual(1)
    for (const file of app.cosChunks()) {
      const hash = createHash('sha256').update(readFileSync(join(app.assetsDir, file))).digest('hex')
      expect(hash).toBe(file.replace('.js', ''))
    }
  })

  it('resolves every manifest chunk entry to a real file', () => {
    const html = app.html()
    const referenced = [...new Set([...html.matchAll(/"file":"([a-f0-9]{64}\.js)"/g)].map(m => m[1]!))]
    expect(referenced.length).toBeGreaterThanOrEqual(1)
    const written = new Set(app.cosChunks())
    for (const file of referenced) {
      expect(written.has(file)).toBe(true)
    }
  })
})

// A package that ships unbundled source, with a cycle between two internal
// modules and a third module shared by both of its entry points. This is the
// shape `vue` and `preact` do not have (they ship pre-bundled `dist` files
// whose only imports cross package boundaries) and `svelte` does.
const CYCLIC_PKG = 'cyclic-fixture'
const SHARED_MARKER = 'cyclic-fixture-shared-state-marker'
const OTHER_MARKER = 'cyclic-fixture-other-entry-marker'
/** Matches the package and every subpath, so both entry points are managed. */
const CYCLIC_MATCHER = new RegExp(`^${CYCLIC_PKG}(?:/|$)`)

function writeCyclicFixture(): { root: string, main: string, other: string } {
  const root = join(scratchRoot, 'node_modules', CYCLIC_PKG)
  mkdirSync(root, { recursive: true })

  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: CYCLIC_PKG,
      version: '1.0.0',
      type: 'module',
      exports: { '.': './index.js', './other': './other.js', './package.json': './package.json' },
    }),
    // `a` and `b` import each other: a cycle that cannot be ordered bottom-up,
    // and so must never be split across chunks.
    'a.js': `import { b } from './b.js'\n`
      + `export const marker = '${SHARED_MARKER}'\n`
      + `let counter = 0\n`
      + `export const bump = () => ++counter\n`
      + `export const read = () => counter\n`
      + `export const a = () => 'a' + b()\n`,
    'b.js': `import { a } from './a.js'\n`
      + `export const b = () => 'b'\n`
      + `export const viaA = () => a()\n`,
    // Both entry points reach `a.js`, so its module state is a singleton the
    // split has to preserve.
    'index.js': `export { a, bump, read, marker } from './a.js'\n`,
    'other.js': `export { bump, read } from './a.js'\nexport const other = '${OTHER_MARKER}'\n`,
  }
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(root, name), source)
  }
  return { root, main: join(root, 'index.js'), other: join(root, 'other.js') }
}

describe('cosPlugin with a package that ships unbundled source', () => {
  let fixture: ReturnType<typeof writeCyclicFixture>
  let alias: Alias[]

  beforeAll(() => {
    fixture = writeCyclicFixture()
    alias = [
      { find: new RegExp(`^${CYCLIC_PKG}$`), replacement: fixture.main },
      { find: new RegExp(`^${CYCLIC_PKG}/other$`), replacement: fixture.other },
    ]
  })

  it('builds a package whose internal imports are cyclic', async () => {
    // Externalising every import, including relative ones, made each source
    // file its own chunk, and `a.js` <-> `b.js` then had no bottom-up order.
    const app = await buildApp(
      `import { a } from "${CYCLIC_PKG}"\ndocument.title = a()\n`,
      [CYCLIC_MATCHER],
      alias,
    )
    expect(app.cosChunks().length).toBeGreaterThanOrEqual(1)
    for (const file of app.cosChunks()) {
      const hash = createHash('sha256').update(readFileSync(join(app.assetsDir, file))).digest('hex')
      expect(hash).toBe(file.replace('.js', ''))
    }
  }, 120_000)

  it('keeps a module shared by two entry points in exactly one chunk', async () => {
    // The point of building a package's entry points together: `index` and
    // `other` both reach `a.js`, whose counter is module state. Two copies of
    // it would be two independent counters.
    const app = await buildApp(
      `import { bump } from "${CYCLIC_PKG}"\n`
      + `import { read } from "${CYCLIC_PKG}/other"\n`
      + `bump()\ndocument.title = String(read())\n`,
      [CYCLIC_MATCHER],
      alias,
    )
    const carrying = app.cosChunks().filter(file => app.read(file).includes(SHARED_MARKER))
    expect(carrying).toHaveLength(1)
  }, 120_000)

  it('produces identical chunks whichever subset of entry points the app imports', async () => {
    // The invariant the whole scheme rests on: a chunk's bytes are a function
    // of the package alone. Two sites importing different entry points must
    // still share whatever chunks they have in common, so the entry set fed to
    // the bundler comes from the package's `exports`, not from the app.
    const [one, both] = await Promise.all([
      buildApp(
        `import { a } from "${CYCLIC_PKG}"\ndocument.title = a()\n`,
        [CYCLIC_MATCHER],
        alias,
      ),
      buildApp(
        `import { a } from "${CYCLIC_PKG}"\n`
        + `import { read } from "${CYCLIC_PKG}/other"\n`
        + `document.title = a() + read()\n`,
        [CYCLIC_MATCHER],
        alias,
      ),
    ])

    const chunksOfOne = new Set(one.cosChunks())
    const chunksOfBoth = new Set(both.cosChunks())

    // Importing a second entry point adds a chunk rather than changing the
    // existing ones.
    expect(chunksOfOne.size).toBeGreaterThanOrEqual(1)
    expect(chunksOfBoth.size).toBeGreaterThan(chunksOfOne.size)
    for (const file of chunksOfOne) {
      expect(chunksOfBoth.has(file), `${file} is not shared by both builds`).toBe(true)
    }
  }, 120_000)

  it('emits only the chunks the app can reach', async () => {
    // Every declared entry point is built, to keep the split deterministic, but
    // one the app never imports must not be shipped.
    const app = await buildApp(
      `import { a } from "${CYCLIC_PKG}"\ndocument.title = a()\n`,
      [CYCLIC_MATCHER],
      alias,
    )
    const emitted = app.cosChunks().map(file => app.read(file)).join('\n')
    expect(emitted).not.toContain(OTHER_MARKER)
  }, 120_000)
})

describe('cosPlugin with pre-bundled and source-shipping packages together', () => {
  it('manages both kinds of package in one build', async () => {
    // vue ships pre-bundled `dist` files whose only imports cross package
    // boundaries; the fixture ships unbundled source with an internal cycle.
    // Both have to be chunked correctly in the same graph.
    const fixture = writeCyclicFixture()
    const app = await buildApp(
      `import { ref } from "vue"\n`
      + `import { a } from "${CYCLIC_PKG}"\n`
      + `document.title = a() + String(ref(0).value)\n`,
      [/^(?:vue$|@vue\/)/, CYCLIC_MATCHER],
      [
        { find: /^vue$/, replacement: resolvePkg('.pnpm/vue@*/node_modules/vue/dist/vue.runtime.esm-bundler.js') },
        { find: new RegExp(`^${CYCLIC_PKG}$`), replacement: fixture.main },
      ],
    )

    const names = app.cosChunks()
    expect(names.length).toBeGreaterThan(1)
    for (const file of names) {
      const hash = createHash('sha256').update(readFileSync(join(app.assetsDir, file))).digest('hex')
      expect(hash).toBe(file.replace('.js', ''))
      for (const specifier of app.specifiersOf(file)) {
        expect(specifier).toMatch(/^cos:[a-f0-9]{64}$/)
      }
    }

    const combined = names.map(file => app.read(file)).join('\n')
    expect(combined).toContain(SHARED_MARKER)
    expect(combined).toMatch(/reactive|effect|ref/)
  }, 120_000)
})

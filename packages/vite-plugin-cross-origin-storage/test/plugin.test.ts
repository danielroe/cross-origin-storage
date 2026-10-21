import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import { build as build7 } from 'vite7'
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
  options: { sourcemap?: boolean, build?: BuildFn, warnings?: string[] } = {},
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
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: options.sourcemap ?? false,
      rollupOptions: {
        input: join(root, 'index.html'),
        onwarn: warning => options.warnings?.push(warning.code ?? warning.message),
      },
    },
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

/** Write a package into `parent`, by default the `node_modules` the scratch apps resolve from. */
function writePackage(name: string, files: Record<string, string>, parent = join(scratchRoot, 'node_modules')): string {
  const dir = join(parent, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content)
  }
  return join(dir, 'index.js')
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

  it('leaves `assets` out of the manifest when no file is referenced', () => {
    expect(app.html()).not.toContain('"assets"')
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
    expect(entry).toMatch(/["'`]vue["'`]/)
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
    expect(entry).toMatch(/import\(\s*["'`]cos1:[a-f0-9]{64}["'`]\s*\)/)
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

describe('cosPlugin with package-internal imports', () => {
  it('hashes an internal import cycle as a group', async () => {
    const entry = writePackage('cos-fixture-cycle', {
      'package.json': '{"name":"cos-fixture-cycle","type":"module","main":"index.js"}',
      'index.js': 'export { a } from "./a.js"\n',
      'a.js': 'import { b } from "./b.js"\nexport const a = () => b\n',
      'b.js': 'import { a } from "./a.js"\nexport const b = () => a\n',
    })
    const app = await buildApp(
      'import { a } from "cos-fixture-cycle"\ndocument.title = String(a)\n',
      ['cos-fixture-cycle'],
      [{ find: /^cos-fixture-cycle$/, replacement: entry }],
    )
    expect(app.cosChunks()).toHaveLength(3)
    for (const file of app.cosChunks()) {
      const hash = createHash('sha256').update(readFileSync(join(app.assetsDir, file))).digest('hex')
      expect(hash).toBe(file.replace('.js', ''))
    }
    // `a.js` and `b.js` are imported, also by each other, by their group's
    // specifiers.
    const imported = [...new Set(app.cosChunks().flatMap(f => app.specifiersOf(f)))].sort()
    expect(imported).toHaveLength(2)
    const group = imported[0]!.replace(/-0$/, '')
    expect(group).toMatch(/^cos1:[a-f0-9]{64}$/)
    expect(imported).toEqual([`${group}-0`, `${group}-1`])
  }, 120_000)

  it('hashes an import cycle the same wherever the package is', async () => {
    const builds = await Promise.all(['one', 'two'].map((tree) => {
      const entry = writePackage('cycle', {
        'index.js': 'export { a } from "./a.js"\n',
        'a.js': 'import { b } from "./b.js"\nexport const a = () => b\n',
        'b.js': 'import { a } from "./a.js"\nexport const b = () => a\n',
      }, join(scratchRoot, tree))
      return buildApp(
        'import { a } from "cycle"\ndocument.title = String(a)\n',
        ['cycle'],
        [{ find: /^cycle$/, replacement: entry }],
      )
    }))
    expect(builds[0]!.cosChunks()).toHaveLength(3)
    expect(builds[0]!.cosChunks().sort()).toEqual(builds[1]!.cosChunks().sort())
  }, 120_000)

  it('hashes an import cycle across packages the same however they are nested', async () => {
    const cycleA = {
      'package.json': '{"name":"cycle-a","type":"module","main":"index.js"}',
      'index.js': 'import { z } from "cycle-z"\nexport const a = () => z\n',
    }
    const cycleZ = {
      'package.json': '{"name":"cycle-z","type":"module","main":"index.js"}',
      'index.js': 'import { a } from "cycle-a"\nexport const z = () => a\n',
    }
    const siblings = join(scratchRoot, 'siblings', 'node_modules')
    const nested = join(scratchRoot, 'nested', 'node_modules')
    writePackage('cycle-z', cycleZ, siblings)
    writePackage('cycle-z', cycleZ, nested)
    const builds = await Promise.all([
      writePackage('cycle-a', cycleA, siblings),
      writePackage('cycle-a', cycleA, join(nested, 'cycle-z', 'node_modules')),
    ].map(entry => buildApp(
      'import { a } from "cycle-a"\ndocument.title = String(a)\n',
      [/^cycle-[az]$/],
      [{ find: /^cycle-a$/, replacement: entry }],
    )))
    expect(builds[0]!.cosChunks()).toHaveLength(2)
    expect(builds[0]!.cosChunks().sort()).toEqual(builds[1]!.cosChunks().sort())
  }, 120_000)

  it('keeps one copy of a module that several entry points of its package import', async () => {
    // Shaped like `three`: `three/addons/*` import `three` by name, and `three`
    // and `three/webgpu` both import `./three.core.js`.
    writePackage('cos-fixture-entries', {
      'package.json': '{"name":"cos-fixture-entries","type":"module","exports":{".":"./index.js","./alt":"./alt.js","./addon":"./addon.js"}}',
      'index.js': 'export * from "./core.js"\n',
      'alt.js': 'export * from "./core.js"\nexport const alt = 1\n',
      'core.js': 'export const core = "the-one-core"\n',
      'addon.js': 'import { core } from "cos-fixture-entries"\nexport const addon = () => core\n',
    })
    const app = await buildApp(
      'import { core } from "cos-fixture-entries"\nimport { alt } from "cos-fixture-entries/alt"\nimport { addon } from "cos-fixture-entries/addon"\ndocument.title = core + alt + addon()\n',
      [/^cos-fixture-entries(?:\/|$)/],
      [],
    )
    expect(app.cosChunks().filter(f => app.read(f).includes('the-one-core'))).toHaveLength(1)
  }, 120_000)

  it('emits files referenced through `new URL(…, import.meta.url)` under their content hash', async () => {
    const decoder = 'decoder-bytes'
    const entry = writePackage('cos-fixture-asset', {
      'package.json': '{"name":"cos-fixture-asset","type":"module","main":"index.js"}',
      'index.js': 'export const local = new URL("./decoder.wasm", import.meta.url).href\nexport const remote = new URL("https://example.com/decoder.wasm", import.meta.url).href\n',
      'decoder.wasm': decoder,
    })
    const app = await buildApp(
      'import { local, remote } from "cos-fixture-asset"\ndocument.title = local + remote\n',
      ['cos-fixture-asset'],
      [{ find: /^cos-fixture-asset$/, replacement: entry }],
    )
    const hash = createHash('sha256').update(decoder).digest('hex')
    expect(readFileSync(join(app.assetsDir, `${hash}.wasm`), 'utf8')).toBe(decoder)

    const chunk = app.cosChunks().map(f => app.read(f)).join('\n')
    expect(chunk).toMatch(new RegExp(`import\\.meta\\.resolve\\(["'\`]cos1:${hash}["'\`]\\)`))
    expect(chunk).not.toContain('cos-asset:')
    expect(chunk).not.toContain(scratchRoot)
    expect(chunk).toContain('https://example.com/decoder.wasm')
    expect(app.html()).toContain(`"assets":{"cos1:${hash}":{"file":"${hash}.wasm"`)
  }, 120_000)

  it('bundles JSON and TypeScript modules of a managed package', async () => {
    const entry = writePackage('cos-fixture-json', {
      'package.json': '{"name":"cos-fixture-json","type":"module","main":"index.js"}',
      'index.js': 'import data from "./data.json"\nimport { offset } from "./offset.ts"\nexport const value = data.value + offset\n',
      'data.json': '{"value":41}',
      'offset.ts': 'export const offset: number = 1\n',
    })
    const app = await buildApp(
      'import { value } from "cos-fixture-json"\ndocument.title = String(value)\n',
      ['cos-fixture-json'],
      [{ find: /^cos-fixture-json$/, replacement: entry }],
    )
    const chunks = app.cosChunks().map(f => app.read(f)).join('\n')
    expect(chunks).toContain('41')
    expect(chunks).not.toContain(': number')
  }, 120_000)

  it('emits files referenced from a TypeScript module', async () => {
    const decoder = 'ts-decoder-bytes'
    const entry = writePackage('cos-fixture-ts-asset', {
      'package.json': '{"name":"cos-fixture-ts-asset","type":"module","main":"index.js"}',
      'index.js': 'export { url } from "./decoder.ts"\n',
      'decoder.ts': 'export const url: string = new URL("./decoder.wasm", import.meta.url).href\n',
      'decoder.wasm': decoder,
    })
    const app = await buildApp(
      'import { url } from "cos-fixture-ts-asset"\ndocument.title = url\n',
      ['cos-fixture-ts-asset'],
      [{ find: /^cos-fixture-ts-asset$/, replacement: entry }],
    )
    const hash = createHash('sha256').update(decoder).digest('hex')
    expect(readFileSync(join(app.assetsDir, `${hash}.wasm`), 'utf8')).toBe(decoder)

    const chunk = app.cosChunks().map(f => app.read(f)).join('\n')
    expect(chunk).toMatch(new RegExp(`import\\.meta\\.resolve\\(["'\`]cos1:${hash}["'\`]\\)`))
    expect(app.html()).toContain(`"assets":{"cos1:${hash}":{"file":"${hash}.wasm"`)
  }, 120_000)

  it('bundles files loaded with require() into the chunk that requires them', async () => {
    writePackage('cos-fixture-cjs', {
      'package.json': '{"name":"cos-fixture-cjs","main":"index.js"}',
      'index.js': 'const other = require("./other.js")\nmodule.exports = { value: other.x + 1 }\n',
      'other.js': 'exports.x = 41\n',
    })
    const app = await buildApp(
      'import cjs from "cos-fixture-cjs"\ndocument.title = String(cjs.value)\n',
      ['cos-fixture-cjs'],
      [],
    )
    const [chunk, ...rest] = app.cosChunks()
    expect(rest).toEqual([])
    const { default: cjs } = await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(app.read(chunk!))}`)
    expect(cjs.value).toBe(42)
  }, 120_000)

  it('inlines the stand-in for a browser field\'s false', async () => {
    const entry = writePackage('cos-fixture-browser-false', {
      'package.json': '{"name":"cos-fixture-browser-false","type":"module","main":"index.js","browser":{"path":false}}',
      'index.js': 'import path from "path"\nexport const hasPath = () => !!path\n',
    })
    const app = await buildApp(
      'import { hasPath } from "cos-fixture-browser-false"\ndocument.title = String(hasPath)\n',
      ['cos-fixture-browser-false'],
      [{ find: /^cos-fixture-browser-false$/, replacement: entry }],
    )
    expect(app.cosChunks()).toHaveLength(1)
  }, 120_000)
})

describe('cosPlugin under Vite 7 (rollup)', () => {
  let app: Built

  beforeAll(async () => {
    app = await buildApp(
      'import { ref } from "vue"\ndocument.body.dataset.count = String(ref(0).value)\n',
      [/^(?:vue$|@vue\/)/],
      [{ find: 'vue', replacement: resolvePkg('.pnpm/vue@*/node_modules/vue/dist/vue.runtime.esm-bundler.js') }],
      { build: build7 as unknown as BuildFn },
    )
  }, 120_000)

  it('emits a chunk shared by modules with identical code once', async () => {
    writePackage('cos-fixture-twins', {
      'package.json': '{"name":"cos-fixture-twins","type":"module","main":"index.js"}',
      'index.js': 'export * as a from "./a.js"\nexport * as b from "./b.js"\n',
      'a.js': 'export const twin = 1\n',
      'b.js': 'export const twin = 1\n',
    })
    const warnings: string[] = []
    const twins = await buildApp(
      'import { a, b } from "cos-fixture-twins"\ndocument.title = String(a.twin + b.twin)\n',
      ['cos-fixture-twins'],
      [],
      { build: build7 as unknown as BuildFn, warnings },
    )
    expect(twins.cosChunks()).toHaveLength(2)
    expect(warnings).toEqual([])
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

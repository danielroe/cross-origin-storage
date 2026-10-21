import { createServer } from 'node:http'
import { createReadStream, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, globSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import type { Server } from 'node:http'
import type { Page } from 'playwright-core'
import { assertExtensionRunnable, launchPlainBrowser, launchWithExtension, skipExtensionTest } from './utils/browser'

const vueEntry = join(realpathSync(fileURLToPath(new URL('../node_modules/vue', import.meta.url))), 'dist/vue.runtime.esm-bundler.js')
const cosChunkPattern = /\/assets\/[a-f0-9]{64}\.js$/
// Build inside the package tree so the app resolves `vue` and Vite emits the
// HTML under a relative fileName.
const scratchRoot = fileURLToPath(new URL('./.browser-scratch', import.meta.url))

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
}

function serve(dir: string): Promise<{ origin: string, close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const path = new URL(req.url!, 'http://localhost').pathname
      const file = join(dir, path === '/' ? 'index.html' : path)
      res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream')
      createReadStream(file).on('error', () => {
        res.statusCode = 404
        res.end('not found')
      }).pipe(res)
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({
        origin: `http://localhost:${port}`,
        close: () => new Promise(r => server.close(() => r())),
      })
    })
  })
}

const COUNTER_APP = 'import { ref, watchEffect } from "vue"\n'
  + 'const count = ref(0)\n'
  + 'const el = document.querySelector("#app")\n'
  + 'watchEffect(() => { el.textContent = `count: ${count.value}` })\n'
  + 'document.querySelector("body").addEventListener("click", () => count.value++)\n'

/** A tiny app whose `main` script only runs once the whole cos chunk graph has. */
function writeApp(main = COUNTER_APP): string {
  mkdirSync(scratchRoot, { recursive: true })
  const root = mkdtempSync(join(scratchRoot, 'app-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head></head><body><p id="app">count: pending</p>'
    + '<script type="module" src="/src/main.js"></script></body></html>',
  )
  writeFileSync(join(root, 'src/main.js'), main)
  return root
}

describe('browser (relative base, served from a sub-path)', () => {
  let root: string
  let server: { origin: string, close: () => Promise<void> }

  beforeAll(async () => {
    root = writeApp()
    const { cosPlugin } = await import('../src/index')
    await build({
      root,
      base: './',
      logLevel: 'error',
      resolve: { alias: { vue: vueEntry } },
      plugins: [cosPlugin({ packages: [/^(?:vue$|@vue\/)/] })],
      build: { outDir: join(root, 'dist'), emptyOutDir: true },
    })
    // The parent is served, so the app sits under /dist/, the way a project
    // page sits under its repository name.
    server = await serve(root)
  }, 120_000)

  afterAll(async () => {
    await server?.close()
    rmSync(scratchRoot, { recursive: true, force: true })
  })

  it('runs the app from a sub-path, resolving the entry against the document', async () => {
    const browser = await launchPlainBrowser()
    try {
      const page = await browser.newPage()
      const missing: string[] = []
      page.on('response', res => res.status() === 404 && missing.push(res.url()))

      await page.goto(`${server.origin}/dist/index.html`, { waitUntil: 'networkidle' })
      await page.locator('body').click()
      await page.locator('#app', { hasText: 'count: 1' }).waitFor({ timeout: 5000 })

      expect(missing, `fetched from outside the sub-path: ${missing.join(', ')}`).toEqual([])
    }
    finally {
      await browser.close()
    }
  })
})

describe('browser (file referenced through `new URL(…, import.meta.url)`)', () => {
  let root: string
  let server: { origin: string, close: () => Promise<void> }

  beforeAll(async () => {
    const pkg = join(scratchRoot, 'node_modules', 'cos-fixture-asset')
    mkdirSync(join(pkg, 'libs'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{"name":"cos-fixture-asset","type":"module","main":"index.js"}')
    writeFileSync(join(pkg, 'index.js'), 'export const url = new URL("./libs/decoder.txt", import.meta.url).href\n')
    writeFileSync(join(pkg, 'libs/decoder.txt'), 'decoded')

    root = mkdtempSync(join(scratchRoot, 'app-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'index.html'),
      '<!doctype html><html><head></head><body><p id="app">pending</p>'
      + '<script type="module" src="/src/main.js"></script></body></html>',
    )
    writeFileSync(
      join(root, 'src/main.js'),
      'import { url } from "cos-fixture-asset"\n'
      + 'fetch(url).then(r => r.text()).then(text => { document.querySelector("#app").textContent = text })\n',
    )

    const { cosPlugin } = await import('../src/index')
    await build({
      root,
      base: './',
      logLevel: 'error',
      resolve: { alias: { 'cos-fixture-asset': join(pkg, 'index.js') } },
      plugins: [cosPlugin({ packages: ['cos-fixture-asset'] })],
      build: { outDir: join(root, 'dist'), emptyOutDir: true },
    })
    server = await serve(root)
  }, 120_000)

  afterAll(async () => {
    await server?.close()
    rmSync(scratchRoot, { recursive: true, force: true })
  })

  it('resolves the file from a managed chunk and fetches it from the network', async () => {
    const browser = await launchPlainBrowser()
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', msg => msg.type() === 'error' && errors.push(msg.text()))

      await page.goto(`${server.origin}/dist/index.html`, { waitUntil: 'networkidle' })
      await page.locator('#app', { hasText: 'decoded' }).waitFor({ timeout: 5000 })

      expect(errors, `errors: ${errors.join(', ')}`).toEqual([])
    }
    finally {
      await browser.close()
    }
  })
})

describe('browser (import cycle)', () => {
  let server: { origin: string, close: () => Promise<void> }

  beforeAll(async () => {
    const pkg = join(scratchRoot, 'node_modules', 'cos-fixture-parity')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{"name":"cos-fixture-parity","type":"module","main":"index.js"}')
    writeFileSync(join(pkg, 'index.js'), 'export { isEven } from "./even.js"\n')
    writeFileSync(join(pkg, 'even.js'), 'import { isOdd } from "./odd.js"\nexport const isEven = n => n === 0 || isOdd(n - 1)\n')
    writeFileSync(join(pkg, 'odd.js'), 'import { isEven } from "./even.js"\nexport const isOdd = n => n !== 0 && isEven(n - 1)\n')
    const root = writeApp('import { isEven } from "cos-fixture-parity"\ndocument.querySelector("#app").textContent = `even: ${isEven(10)}`\n')

    const { cosPlugin } = await import('../src/index')
    await build({
      root,
      logLevel: 'error',
      plugins: [cosPlugin({ packages: ['cos-fixture-parity'] })],
      build: { outDir: join(root, 'dist'), emptyOutDir: true },
    })
    server = await serve(join(root, 'dist'))
  }, 120_000)

  afterAll(async () => {
    await server?.close()
    rmSync(scratchRoot, { recursive: true, force: true })
  })

  it('runs modules that import each other through their group specifiers', async () => {
    const browser = await launchPlainBrowser()
    try {
      const page = await browser.newPage()
      await page.goto(server.origin, { waitUntil: 'networkidle' })
      expect(await page.locator('script[type="importmap"]').textContent()).toMatch(/cos1:[a-f0-9]{64}-1/)
      await page.locator('#app', { hasText: 'even: true' }).waitFor({ timeout: 5000 })
    }
    finally {
      await browser.close()
    }
  })
})

interface StubCosOptions {
  files?: Record<string, string>
  deny?: boolean
  quota?: boolean
}

/** A `navigator.crossOriginStorage` kept in `sessionStorage`, so it survives reloads. */
function stubCos({ files: seed = {}, deny, quota }: StubCosOptions): void {
  const files: Record<string, string> = JSON.parse(sessionStorage.getItem('stub-cos') ?? 'null') ?? seed
  const calls: Array<{ create: boolean, hash: string }> = []
  Object.assign(window, { cosCalls: calls })
  Object.defineProperty(navigator, 'crossOriginStorage', {
    value: {
      async getFileHandle({ value }: { value: string }, { create = false } = {}) {
        calls.push({ create, hash: value })
        if (deny) {
          throw new DOMException('Blocked', 'NotAllowedError')
        }
        if (!create) {
          if (!(value in files)) {
            throw new DOMException('Missing', 'NotFoundError')
          }
          return { getFile: async () => new File([files[value]!], value) }
        }
        return {
          async createWritable() {
            if (quota) {
              throw new DOMException('Full', 'QuotaExceededError')
            }
            const parts: string[] = []
            return {
              write: async (blob: Blob) => { parts.push(await blob.text()) },
              close: async () => {
                files[value] = parts.join('')
                sessionStorage.setItem('stub-cos', JSON.stringify(files))
              },
            }
          },
        }
      },
    },
  })
}

describe('browser (loader with a stub cos)', () => {
  let outDir: string
  let server: { origin: string, close: () => Promise<void> }

  beforeAll(async () => {
    const pkg = join(scratchRoot, 'node_modules', 'cos-fixture-many')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{"name":"cos-fixture-many","type":"module","main":"index.js"}')
    const modules = Array.from({ length: 12 }, (_, n) => `m${n}`)
    writeFileSync(join(pkg, 'index.js'), modules.map(m => `export * from "./${m}.js"\n`).join(''))
    modules.forEach((m, n) => writeFileSync(join(pkg, `${m}.js`), `export const ${m} = "${'x'.repeat(100 * (n + 1))}"\n`))
    const root = writeApp('import * as many from "cos-fixture-many"\ndocument.querySelector("#app").textContent = `modules: ${Object.keys(many).length}`\n')
    outDir = join(root, 'dist')

    const { cosPlugin } = await import('../src/index')
    await build({
      root,
      logLevel: 'error',
      plugins: [cosPlugin({ packages: ['cos-fixture-many'] })],
      build: { outDir, emptyOutDir: true },
    })
    server = await serve(outDir)
  }, 120_000)

  afterAll(async () => {
    await server?.close()
    rmSync(scratchRoot, { recursive: true, force: true })
  })

  async function load(page: Page, { stored = true } = {}): Promise<{ lookups: string[], creates: string[], fetched: string[], errors: string[] }> {
    const fetched: string[] = []
    const errors: string[] = []
    const onResponse = (res: { url: () => string }): void => {
      if (cosChunkPattern.test(new URL(res.url()).pathname)) {
        fetched.push(new URL(res.url()).pathname.slice('/assets/'.length, -'.js'.length))
      }
    }
    const onConsole = (msg: { type: () => string, text: () => string }): void => {
      if (msg.type() === 'error') {
        errors.push(msg.text())
      }
    }
    page.on('response', onResponse)
    page.on('console', onConsole)
    await page.goto(server.origin, { waitUntil: 'networkidle' })
    await page.locator('#app', { hasText: 'modules: 12' }).waitFor({ timeout: 5000 })
    if (stored) {
      await page.waitForFunction(() => localStorage.getItem('cos:stored') !== null)
    }
    page.off('response', onResponse)
    page.off('console', onConsole)
    const calls = await page.evaluate(() => (window as unknown as { cosCalls: Array<{ create: boolean, hash: string }> }).cosCalls)
    return {
      lookups: calls.filter(call => !call.create).map(call => call.hash),
      creates: calls.filter(call => call.create).map(call => call.hash),
      fetched,
      errors,
    }
  }

  function manifestChunks(): Array<{ hash: string, size: number }> {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8')
    return [...html.matchAll(/"hash":"([a-f0-9]{64})",(?:"name":"[^"]*",)?"size":(\d+)/g)]
      .map(([, hash, size]) => ({ hash: hash!, size: Number(size) }))
  }

  it('looks up only the largest chunks it has not stored, then every chunk it has', async () => {
    const chunks = manifestChunks()
    expect(chunks).toHaveLength(13)
    const largest = [...chunks].sort((a, b) => b.size - a.size).slice(0, 8).map(chunk => chunk.hash)

    const browser = await launchPlainBrowser()
    try {
      const page = await browser.newPage()
      await page.addInitScript(stubCos, {})

      const first = await load(page)
      expect(first.lookups.sort()).toEqual(largest.sort())
      expect(first.fetched).toHaveLength(13)
      expect(first.creates).toHaveLength(13)
      expect(first.errors).toEqual([])

      const second = await load(page)
      expect(second.lookups).toHaveLength(13)
      expect(second.fetched).toEqual([])
      expect(second.creates).toEqual([])
    }
    finally {
      await browser.close()
    }
  })

  it('stores chunks found through another site, so later lookups are its own', async () => {
    const files = Object.fromEntries(manifestChunks().map(({ hash }) => [hash, readFileSync(join(outDir, 'assets', `${hash}.js`), 'utf8')]))
    const browser = await launchPlainBrowser()
    try {
      const page = await browser.newPage()
      await page.addInitScript(stubCos, { files })

      const first = await load(page)
      expect(first.fetched).toHaveLength(5)
      expect(first.creates.sort()).toEqual(Object.keys(files).sort())

      const second = await load(page)
      expect(second.lookups).toHaveLength(13)
      expect(second.fetched).toEqual([])
    }
    finally {
      await browser.close()
    }
  })

  it('keeps the hashes that other builds on the same origin stored', async () => {
    const other = 'f'.repeat(64)
    const browser = await launchPlainBrowser()
    try {
      const page = await browser.newPage()
      await page.addInitScript(stubCos, {})
      await load(page)
      await page.evaluate(other => localStorage.setItem('cos:stored', JSON.stringify([other, ...JSON.parse(localStorage.getItem('cos:stored')!)])), other)

      const second = await load(page)
      expect(second.lookups).toHaveLength(13)
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cos:stored')!))).toContain(other)
    }
    finally {
      await browser.close()
    }
  })

  it('stops using cos once a permissions policy blocks it', async () => {
    const browser = await launchPlainBrowser()
    try {
      const page = await browser.newPage()
      await page.addInitScript(stubCos, { deny: true })

      const { lookups, creates, fetched, errors } = await load(page, { stored: false })
      expect(lookups.length + creates.length).toBe(1)
      expect(fetched).toHaveLength(13)
      expect(errors).toEqual([])
    }
    finally {
      await browser.close()
    }
  })

  it('stops storing once the quota is exceeded', async () => {
    const browser = await launchPlainBrowser()
    try {
      const page = await browser.newPage()
      await page.addInitScript(stubCos, { quota: true })

      const { creates, errors } = await load(page, { stored: false })
      expect(creates).toHaveLength(1)
      expect(errors).toEqual([])
    }
    finally {
      await browser.close()
    }
  })

  it('refuses a chunk from the network whose bytes do not match its hash', async () => {
    const [largest] = manifestChunks().sort((a, b) => b.size - a.size)
    const file = join(outDir, 'assets', `${largest!.hash}.js`)
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, `${original}\n`)
    const browser = await launchPlainBrowser()
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', msg => msg.type() === 'error' && errors.push(msg.text()))
      await page.goto(server.origin, { waitUntil: 'networkidle' })
      expect(await page.locator('#app').textContent()).toBe('count: pending')
      expect(errors.join('\n')).toMatch(/integrity/i)
    }
    finally {
      writeFileSync(file, original)
      await browser.close()
    }
  })
})

describe('browser (pure vite build)', () => {
  let outDir: string
  let server: { origin: string, close: () => Promise<void> }

  beforeAll(async () => {
    const root = writeApp()
    outDir = join(root, 'dist')

    const { cosPlugin } = await import('../src/index')
    await build({
      root,
      logLevel: 'error',
      resolve: { alias: { vue: vueEntry } },
      plugins: [cosPlugin({ packages: [/^(?:vue$|@vue\/)/] })],
      build: { outDir, emptyOutDir: true },
    })
    server = await serve(outDir)
  }, 120_000)

  afterAll(async () => {
    await server?.close()
    rmSync(scratchRoot, { recursive: true, force: true })
  })

  async function runApp(page: Page): Promise<void> {
    await page.goto(server.origin, { waitUntil: 'networkidle' })
    const importMap = await page.locator('script[type="importmap"]').textContent()
    expect(importMap).toMatch(/cos1:[a-f0-9]{64}/)
    // The counter only updates if the whole cos chunk graph resolved and ran.
    await page.locator('body').click()
    await page.locator('#app', { hasText: 'count: 1' }).waitFor({ timeout: 5000 })
    expect(await page.locator('#app').textContent()).toBe('count: 1')
  }

  describe('without the cos extension (network fallback)', () => {
    it('runs the app and loads every managed chunk over the network', async () => {
      const browser = await launchPlainBrowser()
      try {
        const page = await browser.newPage()
        const cosChunks = new Set<string>()
        const errors: string[] = []
        page.on('console', msg => msg.type() === 'error' && errors.push(msg.text()))
        page.on('response', (res) => {
          if (cosChunkPattern.test(new URL(res.url()).pathname)) {
            expect(res.status()).toBe(200)
            cosChunks.add(new URL(res.url()).pathname)
          }
        })

        await runApp(page)

        expect(await page.evaluate(() => 'crossOriginStorage' in navigator)).toBe(false)
        expect(cosChunks.size).toBeGreaterThanOrEqual(5)
        expect(errors, `console errors: ${errors.join(', ')}`).toEqual([])
      }
      finally {
        await browser.close()
      }
    })
  })

  describe.skipIf(skipExtensionTest())('with the cos extension', () => {
    let userDataDir: string

    beforeAll(() => {
      assertExtensionRunnable()
      userDataDir = mkdtempSync(join(tmpdir(), 'cos-ext-'))
    })

    afterAll(() => {
      rmSync(userDataDir, { recursive: true, force: true })
    })

    it('stores chunks in cos on first load, then serves them from cos without the network', async () => {
      const context = await launchWithExtension(userDataDir)
      try {
        const page = await context.newPage()
        const cosErrors: string[] = []
        page.on('console', (msg) => {
          if (msg.type() === 'error' && msg.text().includes('[cos]')) cosErrors.push(msg.text())
        })

        await page.goto(server.origin, { waitUntil: 'networkidle' })
        expect(await page.evaluate(() => 'crossOriginStorage' in navigator)).toBe(true)
        await page.waitForTimeout(500)
        expect(cosErrors, `cos errors on first load: ${cosErrors.join(' | ')}`).toEqual([])

        const networkCosChunks: string[] = []
        page.on('response', (res) => {
          if (cosChunkPattern.test(new URL(res.url()).pathname)) {
            networkCosChunks.push(res.url())
          }
        })
        await page.reload({ waitUntil: 'networkidle' })

        await page.locator('body').click()
        await page.locator('#app', { hasText: 'count: 1' }).waitFor({ timeout: 5000 })
        expect(await page.locator('#app').textContent()).toBe('count: 1')

        expect(networkCosChunks, `chunks fetched from network instead of COS: ${networkCosChunks.join(', ')}`).toEqual([])
      }
      finally {
        await context.close()
      }
    })
  })

  it('keeps the unused exports so the chunk is shareable regardless of usage', () => {
    // The app only imports `ref`/`watchEffect`, but the vue chunk must contain
    // the full public surface so two sites sharing it get identical bytes.
    const cos = globSync('assets/*.js', { cwd: outDir }).filter(f => /[a-f0-9]{64}\.js$/.test(f))
    const total = cos.reduce((sum, f) => sum + readFileSync(join(outDir, f)).length, 0)
    expect(total).toBeGreaterThan(100_000)
  })
})

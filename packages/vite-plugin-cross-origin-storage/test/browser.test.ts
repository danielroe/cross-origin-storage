import { createServer } from 'node:http'
import { createReadStream, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, globSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import type { Server } from 'node:http'
import type { Page } from 'playwright-core'
import { assertExtensionRunnable, launchPlainBrowser, launchWithExtension, skipExtensionTest } from './utils/browser'

const nodeModules = fileURLToPath(new URL('../../../node_modules', import.meta.url))
const vueEntry = join(nodeModules, globSync('.pnpm/vue@*/node_modules/vue/dist/vue.runtime.esm-bundler.js', { cwd: nodeModules })[0]!)
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

describe('browser (pure vite build)', () => {
  let outDir: string
  let server: { origin: string, close: () => Promise<void> }

  beforeAll(async () => {
    mkdirSync(scratchRoot, { recursive: true })
    const root = mkdtempSync(join(scratchRoot, 'app-'))
    outDir = join(root, 'dist')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'index.html'),
      '<!doctype html><html><head></head><body><p id="app">count: pending</p>'
      + '<script type="module" src="/src/main.js"></script></body></html>',
    )
    // Hydration-equivalent: mount a counter so the test can prove the cos chunk
    // graph actually executed in the browser, not just that it loaded.
    writeFileSync(
      join(root, 'src/main.js'),
      'import { ref, watchEffect } from "vue"\n'
      + 'const count = ref(0)\n'
      + 'const el = document.querySelector("#app")\n'
      + 'watchEffect(() => { el.textContent = `count: ${count.value}` })\n'
      + 'document.querySelector("body").addEventListener("click", () => count.value++)\n',
    )

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

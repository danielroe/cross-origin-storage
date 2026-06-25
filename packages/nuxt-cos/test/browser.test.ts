import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setup, url } from '@nuxt/test-utils/e2e'
import type { Page } from 'playwright-core'
import { assertExtensionRunnable, launchPlainBrowser, launchWithExtension, skipExtensionTest } from './utils/browser'

const cosChunkPattern = /\/_nuxt\/[a-f0-9]{64}\.js$/

// The COS extension's content scripts match `http://localhost:*` but not the
// `127.0.0.1` host that @nuxt/test-utils binds to; both are loopback.
function localhost(target: string): string {
  return target.replace('127.0.0.1', 'localhost')
}

async function hydrate(page: Page): Promise<{ errors: string[], failed: string[] }> {
  const errors: string[] = []
  const failed: string[] = []
  page.on('console', msg => msg.type() === 'error' && errors.push(msg.text()))
  page.on('requestfailed', req => failed.push(req.url()))

  await page.goto(url('/'), { waitUntil: 'networkidle' })

  const importMap = await page.locator('script[type="importmap"]').textContent()
  expect(importMap).toMatch(/cos1:[a-f0-9]{64}/)

  // Hydration only completes if the whole cos chunk graph resolved and ran.
  await page.locator('button').click()
  await page.locator('p', { hasText: 'count: 1' }).waitFor({ timeout: 5000 })
  expect(await page.locator('p').textContent()).toBe('count: 1')

  return { errors, failed }
}

describe('browser', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/basic', import.meta.url)),
    build: true,
  })

  describe('without the cos extension (network fallback)', () => {
    it('hydrates the app and loads every managed chunk over the network', async () => {
      const browser = await launchPlainBrowser()
      try {
        const page = await browser.newPage()
        const cosChunks = new Set<string>()
        page.on('response', (res) => {
          const path = new URL(res.url()).pathname
          if (cosChunkPattern.test(path)) {
            expect(res.status(), `${path} returned ${res.status()}`).toBe(200)
            cosChunks.add(path)
          }
        })

        const { errors, failed } = await hydrate(page)

        expect(await page.evaluate(() => 'crossOriginStorage' in navigator)).toBe(false)
        // vue + runtime-dom + runtime-core + reactivity + shared
        expect(cosChunks.size).toBe(5)
        expect(failed, `failed requests: ${failed.join(', ')}`).toEqual([])
        expect(errors, `console errors: ${errors.join(', ')}`).toEqual([])
      }
      finally {
        await browser.close()
      }
    })
  })

  // Skip only when explicitly opted out; otherwise a missing extension or
  // browser is a setup failure and throws in beforeAll.
  describe.skipIf(skipExtensionTest())('with the cos extension', () => {
    let userDataDir: string

    beforeAll(async () => {
      assertExtensionRunnable()
      userDataDir = await mkdtemp(join(tmpdir(), 'cos-ext-'))
    })

    afterAll(async () => {
      await rm(userDataDir, { recursive: true, force: true })
    })

    it('stores chunks in cos on first load, then serves them from cos without the network', async () => {
      const context = await launchWithExtension(userDataDir)
      try {
        const page = await context.newPage()
        const cosErrors: string[] = []
        page.on('console', (msg) => {
          if (msg.type() === 'error' && msg.text().includes('[cos]')) cosErrors.push(msg.text())
        })

        // First load: cold cache, the extension injects the API and the loader
        // stores every managed chunk in COS.
        await page.goto(localhost(url('/')), { waitUntil: 'networkidle' })
        expect(await page.evaluate(() => 'crossOriginStorage' in navigator)).toBe(true)

        // The store is async; give it a beat to settle. A declared hash that
        // disagrees with the served bytes surfaces here as a COS store error.
        await page.waitForTimeout(500)
        expect(cosErrors, `cos errors on first load: ${cosErrors.join(' | ')}`).toEqual([])

        // Second load: chunks must come from COS, not the network. The
        // persistent context keeps the COS store across reloads.
        const networkCosChunks: string[] = []
        page.on('response', (res) => {
          if (cosChunkPattern.test(new URL(res.url()).pathname)) {
            networkCosChunks.push(res.url())
          }
        })
        await page.reload({ waitUntil: 'networkidle' })

        await page.locator('button').click()
        await page.locator('p', { hasText: 'count: 1' }).waitFor({ timeout: 5000 })
        expect(await page.locator('p').textContent()).toBe('count: 1')

        expect(networkCosChunks, `chunks fetched from network instead of COS: ${networkCosChunks.join(', ')}`).toEqual([])
      }
      finally {
        await context.close()
      }
    })
  })
})

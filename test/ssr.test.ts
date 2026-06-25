import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { $fetch, setup } from '@nuxt/test-utils/e2e'
import type { CosManifest } from '../src/runtime/loader'

function parseManifest(html: string): CosManifest {
  const start = html.indexOf('{"base":')
  expect(start, 'cos manifest not found in loader script').toBeGreaterThan(-1)

  let depth = 0
  for (let i = start; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}' && --depth === 0) {
      return JSON.parse(html.slice(start, i + 1)) as CosManifest
    }
  }
  throw new Error('unterminated cos manifest')
}

describe('ssr', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/basic', import.meta.url)),
    build: true,
  })

  it('renders the server-rendered markup', async () => {
    const html = await $fetch('/')
    expect(html).toContain('count: 0')
  })

  it('injects the cos loader and removes the default entry script', async () => {
    const html = await $fetch('/')
    expect(html).toContain('<script id="cos-loader">')
    expect(html).toMatch(/cos1:[a-f0-9]{64}/)
    expect(html).not.toMatch(/<script type="module"[^>]*src="\/_nuxt\/[^"]*"/)
  })

  it('keys every managed chunk by the content hash it declares', async () => {
    const { chunks } = parseManifest(await $fetch('/'))
    expect(Object.keys(chunks).length).toBe(5)
    for (const [specifier, { hash }] of Object.entries(chunks)) {
      expect(specifier).toBe(`cos1:${hash}`)
    }
  })

  it('declares an entry that is loaded outside cos', async () => {
    const { entry, chunks } = parseManifest(await $fetch('/'))
    expect(entry.specifier).toBe('cos1:entry')
    expect(entry.file).toBeTruthy()
    // The entry is app-specific and must not be a COS-managed chunk.
    expect(chunks[entry.specifier]).toBeUndefined()
  })
})

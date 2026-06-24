import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { $fetch, setup } from '@nuxt/test-utils/e2e'

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
    expect(html).toContain('coschunk-vue')
    expect(html).not.toMatch(/<script type="module"[^>]*src="\/_nuxt\/[^"]*"/)
  })

  it('inlines a manifest entry that resolves to a real chunk', async () => {
    const html = await $fetch('/')
    const entry = html.match(/"entry":"(coschunk-[^"]+)"/)?.[1]
    expect(entry).toBeDefined()
    const chunks = html.match(/"chunks":\{(.+?)\}\}\)/)?.[1] ?? ''
    expect(chunks).toContain(`"${entry}":`)
  })
})

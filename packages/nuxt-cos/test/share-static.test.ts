import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fetch, setup } from '@nuxt/test-utils/e2e'

const ALLOW_ORIGIN = 'cross-origin-storage-allow-origin'

describe('static share list', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/basic', import.meta.url)),
    build: true,
    nuxtConfig: {
      cos: {
        packages: [/^(?:vue$|@vue\/)/],
        share: ['https://b.example/', 'https://a.example'],
      },
      routeRules: {
        '/custom': { headers: { 'Cross-Origin-Storage-Allow-Origin': 'https://c.example' } },
      },
    },
  })

  it('sends the normalized list on rendered pages', async () => {
    const response = await fetch('/')
    expect(response.headers.get(ALLOW_ORIGIN)).toBe('https://a.example, https://b.example')
  })

  it('sets it through route rules, which static hosting presets also emit', async () => {
    // Only route rules reach a response that Nitro does not render, such as a 404.
    const response = await fetch('/_nuxt/missing.js')
    expect(response.headers.get(ALLOW_ORIGIN)).toBe('https://a.example, https://b.example')
  })

  it('keeps a header the app sets itself', async () => {
    const response = await fetch('/custom')
    expect(response.headers.get(ALLOW_ORIGIN)).toBe('https://c.example')
  })
})

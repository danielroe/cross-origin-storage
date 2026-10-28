import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'

const ALLOW_ORIGIN = 'cross-origin-storage-allow-origin'

describe('share resolved per package', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/basic', import.meta.url)),
    build: true,
    nuxtConfig: {
      cos: {
        packages: [/^(?:vue$|@vue\/)/],
        share: name => name === 'vue' ? '*' : ['https://b.example', 'https://a.example'],
      },
    },
  })

  it('sends the union of every list on rendered pages', async () => {
    const response = await fetch('/')
    expect(response.headers.get('content-type')).toMatch(/^text\/html/)
    expect(response.headers.get(ALLOW_ORIGIN)).toBe('https://a.example, https://b.example')
  })

  it('leaves the header off the chunks, whose response does not bound the loader\'s writes', async () => {
    const html = await $fetch<string>('/')
    const file = html.match(/"file":"([a-f0-9]{64}\.js)"/)?.[1]
    expect(file).toBeTruthy()
    const response = await fetch(`/_nuxt/${file}`)
    expect(response.ok).toBe(true)
    expect(response.headers.get(ALLOW_ORIGIN)).toBeNull()
  })
})

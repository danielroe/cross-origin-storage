import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 240_000,
    // The fixture is built into shared `.output` / `.nuxt` dirs; running test
    // files in parallel makes their builds clobber each other.
    fileParallelism: false,
  },
})

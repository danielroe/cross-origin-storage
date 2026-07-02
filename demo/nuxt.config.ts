export default defineNuxtConfig({
  modules: ['nuxt-cos'],
  compatibilityDate: '2025-01-01',
  cos: {
    // Managed here explicitly (this is also the module's default), so that
    // `@vue/*` and their dependencies are extracted into content-addressed
    // Cross-Origin Storage chunks by vite-plugin-cross-origin-storage.
    packages: [/^(?:vue$|@vue\/)/],
  },
})

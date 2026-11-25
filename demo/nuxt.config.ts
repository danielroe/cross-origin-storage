export default defineNuxtConfig({
  modules: ['nuxt-cos'],
  compatibilityDate: '2025-01-01',
  cos: {
    // Managed here explicitly (this is also the module's default), so that
    // `@vue/*` and their dependencies are extracted into content-addressed
    // Cross-Origin Storage chunks by vite-plugin-cross-origin-storage.
    packages: [/^(?:vue$|@vue\/)/],
    // Who may read the chunks once they are stored. `vue` suits the default,
    // every origin (`'*'`). To try the other scopes, uncomment one of these and
    // rebuild; the table on the page shows the result. See the README.
    // share: 'same-site',
    // share: ['https://a.example', 'https://b.example'],
  },
})

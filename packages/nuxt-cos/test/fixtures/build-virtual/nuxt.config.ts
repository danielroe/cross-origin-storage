export default defineNuxtConfig({
  modules: ['nuxt-cos'],
  cos: {
    packages: [/^#app(?:\/|$)/],
  },
})

<template>
  <main>
    <h1>nuxt-cos demo</h1>
    <p>
      This is a plain Nuxt app using the
      <a href="https://github.com/danielroe/cross-origin-storage/tree/main/packages/nuxt-cos">nuxt-cos</a>
      module, which wraps
      <a href="https://github.com/danielroe/cross-origin-storage/tree/main/packages/vite-plugin-cross-origin-storage">vite-plugin-cross-origin-storage</a>
      to extract <code>vue</code> and <code>@vue/*</code> into content-addressed
      <a href="https://github.com/WICG/cross-origin-storage">Cross-Origin Storage (COS)</a>
      chunks.
    </p>

    <section class="counter">
      <p>Vue {{ vueVersion }} is doing the rendering: count is {{ count }}</p>
      <button @click="count++">
        increment
      </button>
    </section>

    <section v-if="resources.length" class="resources">
      <h2>COS-managed resources</h2>
      <table>
        <thead>
          <tr>
            <th>Package</th>
            <th>Hash</th>
            <th>Chunk</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="resource in resources" :key="resource.specifier">
            <td>{{ resource.name ?? '(unknown)' }}</td>
            <td><code>{{ resource.hash.slice(0, 12) }}…</code></td>
            <td><a :href="resource.href">{{ resource.file }}</a></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="note">
      <p>
        <strong>The module is a no-op in dev.</strong> To see the COS
        chunking in action, build and preview:
      </p>
      <pre><code>pnpm --filter nuxt-cos-demo build
pnpm --filter nuxt-cos-demo preview</code></pre>
      <p>
        Then check <code>.output/public/_nuxt/</code> for content-hashed
        chunk files, and view source on the page: the default Nuxt entry
        script is replaced with a <code>&lt;script id="cos-loader"&gt;</code>.
        The table above (populated once the loader has run) shows which
        npm package produced each chunk.
      </p>
    </section>
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref, version as vueVersion } from 'vue'
import type { CosManifest } from 'vite-plugin-cross-origin-storage'

useHead({
  title: 'nuxt-cos demo',
})

const count = ref(0)

const resources = ref<Array<{ specifier: string, name?: string, hash: string, file: string, href: string }>>([])

onMounted(() => {
  const manifest = (window as unknown as { __cosManifest?: CosManifest }).__cosManifest
  if (!manifest) {
    return
  }
  resources.value = Object.entries(manifest.chunks).map(([specifier, chunk]) => ({
    specifier,
    name: chunk.name,
    hash: chunk.hash,
    file: chunk.file,
    href: manifest.base + chunk.file,
  }))
})
</script>

<style>
body {
  font-family: system-ui, sans-serif;
  max-width: 40rem;
  margin: 3rem auto;
  line-height: 1.5;
  padding: 0 1rem;
}

pre {
  background: #f4f4f4;
  padding: 0.75rem 1rem;
  border-radius: 0.25rem;
  overflow-x: auto;
}

.counter {
  margin: 2rem 0;
  padding: 1rem;
  border: 1px solid #ddd;
  border-radius: 0.5rem;
}

.note {
  color: #555;
}

.resources table {
  width: 100%;
  border-collapse: collapse;
}

.resources th,
.resources td {
  text-align: left;
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid #ddd;
}
</style>

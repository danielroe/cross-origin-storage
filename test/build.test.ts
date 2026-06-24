import { execSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./fixtures/basic', import.meta.url))
const publicNuxt = join(fixtureDir, '.output/public/_nuxt')

function importsOf(file: string): string[] {
  const code = readFileSync(join(publicNuxt, file), 'utf8')
  const specifiers = [...code.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map(m => m[1]!)
  return [...new Set(specifiers)]
}

describe('cos build output', () => {
  beforeAll(() => {
    rmSync(join(fixtureDir, '.output'), { recursive: true, force: true })
    rmSync(join(fixtureDir, '.nuxt'), { recursive: true, force: true })
    execSync('npx nuxi build', { cwd: fixtureDir, stdio: 'inherit' })
  }, 240_000)

  it('emits a standalone chunk for every managed vue package', () => {
    const files = readdirSync(publicNuxt)
    for (const name of ['vue', 'vue-runtime-dom', 'vue-runtime-core', 'vue-reactivity', 'vue-shared']) {
      expect(files, `missing ${name}.js`).toContain(`${name}.js`)
    }
  })

  it('externalises managed packages instead of inlining them (no duplication)', () => {
    // If vue were self-contained it would be ~300KB; externalised it is tiny.
    const vue = readFileSync(join(publicNuxt, 'vue.js'), 'utf8')
    expect(vue.length).toBeLessThan(5_000)
    expect(importsOf('vue.js')).toEqual(['coschunk-vue-runtime-dom'])
  })

  it('keeps the reactivity singleton as a single shared leaf chunk', () => {
    // @vue/shared is imported by every other vue chunk and imports nothing.
    expect(importsOf('vue-shared.js')).toEqual([])
    for (const dependant of ['vue-runtime-dom', 'vue-runtime-core', 'vue-reactivity']) {
      expect(importsOf(`${dependant}.js`)).toContain('coschunk-vue-shared')
    }
  })

  it('leaves no dangling bare vue specifiers in any chunk', () => {
    for (const file of readdirSync(publicNuxt).filter(f => f.endsWith('.js'))) {
      const bare = importsOf(file).filter(s => /^(?:vue|@vue\/)/.test(s))
      expect(bare, `${file} still imports ${bare.join(', ')}`).toEqual([])
    }
  })
})

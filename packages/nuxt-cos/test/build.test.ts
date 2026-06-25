import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./fixtures/basic', import.meta.url))
const publicNuxt = join(fixtureDir, '.output/public/_nuxt')

function build(): void {
  rmSync(join(fixtureDir, '.output'), { recursive: true, force: true })
  rmSync(join(fixtureDir, '.nuxt'), { recursive: true, force: true })
  execSync('npx nuxi build', { cwd: fixtureDir, stdio: 'inherit' })
}

function cosChunks(): string[] {
  return readdirSync(publicNuxt).filter(f => /^[a-f0-9]{64}\.js$/.test(f))
}

function specifiersOf(file: string): string[] {
  const code = readFileSync(join(publicNuxt, file), 'utf8')
  const specifiers = [...code.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map(m => m[1]!)
  return [...new Set(specifiers)]
}

describe('cos build output', () => {
  beforeAll(build, 240_000)

  it('emits one content-addressed chunk per managed vue package', () => {
    // vue + runtime-dom + runtime-core + reactivity + shared
    expect(cosChunks()).toHaveLength(5)
  })

  it('names every chunk after the sha-256 of its bytes', () => {
    for (const file of cosChunks()) {
      const hash = file.replace('.js', '')
      const actual = createHash('sha256').update(readFileSync(join(publicNuxt, file))).digest('hex')
      expect(actual).toBe(hash)
    }
  })

  it('references dependencies only by content-addressed specifier', () => {
    for (const file of cosChunks()) {
      for (const specifier of specifiersOf(file)) {
        expect(specifier, `${file} imports non-content-addressed ${specifier}`).toMatch(/^cos1:[a-f0-9]{64}$/)
      }
    }
  })

  it('externalises shared dependencies instead of inlining them (no duplication)', () => {
    const sizes = cosChunks().map(f => readFileSync(join(publicNuxt, f)).length)
    // A self-contained vue would be ~150KB minified; externalised it is tiny.
    expect(Math.min(...sizes)).toBeLessThan(1_000)
  })

  it('keeps the reactivity singleton as a single shared leaf chunk', () => {
    const chunks = cosChunks()
    const leaves = chunks.filter(f => specifiersOf(f).length === 0)
    // @vue/shared is the only package that imports nothing; if it were
    // duplicated or inlined there would be zero or several leaves.
    expect(leaves, 'expected exactly one dependency-free leaf (@vue/shared)').toHaveLength(1)

    const leafSpecifier = `cos1:${leaves[0]!.replace('.js', '')}`
    const directDependants = chunks.filter(f => specifiersOf(f).includes(leafSpecifier))
    // runtime-dom, runtime-core and reactivity all import @vue/shared directly.
    expect(directDependants.length).toBeGreaterThanOrEqual(3)
  })

  it('leaves no machine-specific paths in any chunk', () => {
    for (const file of cosChunks()) {
      const code = readFileSync(join(publicNuxt, file), 'utf8')
      expect(code, `${file} leaks a path`).not.toMatch(/node_modules|cos-ext:|#region/)
    }
  })

  it('produces identical hashes when rebuilt (deterministic)', () => {
    const first = cosChunks().sort()
    build()
    expect(cosChunks().sort()).toEqual(first)
  }, 240_000)
})

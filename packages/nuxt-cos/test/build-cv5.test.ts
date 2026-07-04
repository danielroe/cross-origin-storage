import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import type { CosManifest } from 'vite-plugin-cross-origin-storage'

const fixtureDir = fileURLToPath(new URL('./fixtures/basic-cv5', import.meta.url))
const nitroChunk = join(fixtureDir, '.output/server/chunks/nitro/nitro.mjs')
const publicNuxt = join(fixtureDir, '.output/public/_nuxt')
const clientNuxt = join(fixtureDir, '.nuxt/dist/client/_nuxt')
const clientAssets = join(fixtureDir, '.nuxt/dist/client/assets')

function build(): void {
  rmSync(join(fixtureDir, '.output'), { recursive: true, force: true })
  rmSync(join(fixtureDir, '.nuxt'), { recursive: true, force: true })
  execSync('npx nuxi build', { cwd: fixtureDir, stdio: 'inherit' })
}

function parseManifest(): CosManifest {
  const code = readFileSync(nitroChunk, 'utf8')
  const start = code.indexOf('{\\"base\\":')
  expect(start, 'cos manifest not found in nitro output').toBeGreaterThan(-1)

  let depth = 0
  for (let i = start; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) {
      return JSON.parse(code.slice(start, i + 1).replace(/\\"/g, '"')) as CosManifest
    }
  }
  throw new Error('unterminated cos manifest')
}

describe('compatibilityVersion 5 build output', () => {
  beforeAll(build, 240_000)

  it('keeps entry and chunk files relative to the _nuxt base', () => {
    const { base, entry, chunks } = parseManifest()
    expect(base).toBe('/_nuxt/')
    expect(entry.file).not.toMatch(/^_nuxt\//)
    expect(existsSync(join(publicNuxt, entry.file))).toBe(true)
    expect(readdirSync(clientNuxt).some(file => /^[a-f0-9]{64}\.js$/.test(file))).toBe(true)
    expect(existsSync(clientAssets)).toBe(false)

    for (const { file } of Object.values(chunks)) {
      expect(existsSync(join(publicNuxt, file))).toBe(true)
    }
  })
})

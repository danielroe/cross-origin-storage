import { execSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./fixtures/build-virtual', import.meta.url))

describe('nuxt #app is rejected as a cos candidate', () => {
  it('fails the build with a clear diagnostic, not a raw resolve error', () => {
    // `#app` is stitched together from per-app build virtuals (`#build/*`,
    // `#imports`, ...), so it is neither self-contained nor shareable across
    // origins. The plugin must say so rather than emit a cryptic error.
    rmSync(join(fixtureDir, '.output'), { recursive: true, force: true })
    rmSync(join(fixtureDir, '.nuxt'), { recursive: true, force: true })

    let output = ''
    expect(() => {
      try {
        execSync('npx nuxi build', { cwd: fixtureDir, encoding: 'utf8', stdio: 'pipe' })
      }
      catch (error) {
        output = `${(error as { stdout?: string }).stdout ?? ''}${(error as { stderr?: string }).stderr ?? ''}`
        throw error
      }
    }).toThrow()

    expect(output).toContain('cannot bundle managed package as a standalone chunk')
  }, 240_000)
})

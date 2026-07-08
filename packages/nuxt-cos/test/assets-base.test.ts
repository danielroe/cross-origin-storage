import { describe, expect, it } from 'vitest'
import { resolveBuildAssetsBase } from '../src/runtime/utils/assets-base'

describe('resolveBuildAssetsBase', () => {
  it('joins baseURL with buildAssetsDir', () => {
    expect(resolveBuildAssetsBase({
      baseURL: '/',
      buildAssetsDir: '/cms/_nuxt/',
    })).toBe('/cms/_nuxt/')
  })

  it('uses cdnURL over baseURL when set', () => {
    expect(resolveBuildAssetsBase({
      baseURL: '/',
      buildAssetsDir: '/_nuxt/',
      cdnURL: 'https://cdn.example.com/',
    })).toBe('https://cdn.example.com/_nuxt/')
  })

  it('defaults public base to /', () => {
    expect(resolveBuildAssetsBase({
      buildAssetsDir: '/_nuxt/',
    })).toBe('/_nuxt/')
  })
})

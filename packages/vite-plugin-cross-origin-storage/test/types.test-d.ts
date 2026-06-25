import { assertType, describe, expectTypeOf, it } from 'vitest'
import { cosPlugin } from '../src/index'
import type { CosManifest, CosPluginOptions } from '../src/index'
import type { Plugin } from 'vite'

describe('cosPlugin', () => {
  it('returns a vite plugin', () => {
    expectTypeOf(cosPlugin).returns.toEqualTypeOf<Plugin>()
  })

  it('requires the packages option', () => {
    // @ts-expect-error packages is required
    assertType<CosPluginOptions>({})
    assertType<CosPluginOptions>({ packages: ['vue'] })
    assertType<CosPluginOptions>({ packages: [/^vue$/, '@vue/runtime-core'] })
  })

  it('accepts the optional options', () => {
    assertType<CosPluginOptions>({
      packages: ['vue'],
      base: '/_nuxt/',
      loaderEntry: '/path/to/loader.entry.mjs',
      onGenerated: (script) => {
        expectTypeOf(script).toEqualTypeOf<string>()
      },
    })
  })

  it('rejects unknown options', () => {
    // @ts-expect-error unknown option
    assertType<CosPluginOptions>({ packages: ['vue'], unknown: true })
  })

  it('types packages as a string/RegExp array', () => {
    expectTypeOf<CosPluginOptions['packages']>().toEqualTypeOf<Array<string | RegExp>>()
  })
})

describe('CosManifest', () => {
  it('describes the manifest shape consumed by the loader', () => {
    expectTypeOf<CosManifest>().toEqualTypeOf<{
      base: string
      entry: { specifier: string, file: string }
      chunks: Record<string, { file: string, hash: string }>
    }>()
  })
})

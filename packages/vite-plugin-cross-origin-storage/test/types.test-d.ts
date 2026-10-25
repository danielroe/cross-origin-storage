import { assertType, describe, expectTypeOf, it } from 'vitest'
import { cosPlugin, RECIPE } from '../src/index'
import type { CosManifest, CosPluginOptions, CosShare } from '../src/index'
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

  it('accepts every share mode, statically or per package', () => {
    assertType<CosPluginOptions>({ packages: ['vue'], share: '*' })
    assertType<CosPluginOptions>({ packages: ['vue'], share: 'same-site' })
    assertType<CosPluginOptions>({ packages: ['vue'], share: ['https://a.example', 'https://b.example'] })
    assertType<CosPluginOptions>({
      packages: ['vue'],
      share: (name) => {
        expectTypeOf(name).toEqualTypeOf<string | undefined>()
        return name === 'vue' ? '*' : 'same-site'
      },
    })
    // @ts-expect-error not a share mode
    assertType<CosPluginOptions>({ packages: ['vue'], share: 'same-origin' })
  })

  it('rejects unknown options', () => {
    // @ts-expect-error unknown option
    assertType<CosPluginOptions>({ packages: ['vue'], unknown: true })
  })

  it('types packages as a string/RegExp array', () => {
    expectTypeOf<CosPluginOptions['packages']>().toEqualTypeOf<Array<string | RegExp>>()
  })
})

describe('RECIPE', () => {
  it('is typed as a number', () => {
    expectTypeOf(RECIPE).toEqualTypeOf<number>()
  })
})

describe('CosShare', () => {
  it('is every origin, same-site or a list of origins', () => {
    expectTypeOf<CosShare>().toEqualTypeOf<'*' | 'same-site' | string[]>()
  })
})

describe('CosManifest', () => {
  it('describes the manifest shape consumed by the loader', () => {
    expectTypeOf<CosManifest>().toEqualTypeOf<{
      base: string
      recipe: number
      entry: { specifier: string, file: string }
      chunks: Record<string, { file: string, hash: string, name?: string, size: number, share?: 'same-site' | string[] }>
      assets?: Record<string, { file: string, hash: string, name?: string }>
    }>()
  })
})

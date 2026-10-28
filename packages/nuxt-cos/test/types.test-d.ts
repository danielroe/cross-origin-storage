import { assertType, describe, expectTypeOf, it } from 'vitest'
import type { ModuleOptions } from '../src/module'

describe('ModuleOptions', () => {
  it('types packages as a string/RegExp array', () => {
    expectTypeOf<ModuleOptions['packages']>().toEqualTypeOf<Array<string | RegExp>>()
  })

  it('accepts string and RegExp package matchers', () => {
    assertType<ModuleOptions>({ packages: ['vue', /^@vue\//] })
  })

  it('accepts every share mode', () => {
    assertType<ModuleOptions>({ packages: ['vue'], share: '*' })
    assertType<ModuleOptions>({ packages: ['vue'], share: 'same-site' })
    assertType<ModuleOptions>({ packages: ['vue'], share: ['https://a.example'] })
    assertType<ModuleOptions>({ packages: ['vue'], share: name => name === 'vue' ? '*' : 'same-site' })
  })

  it('rejects non-string/RegExp matchers', () => {
    // @ts-expect-error packages entries must be string | RegExp
    assertType<ModuleOptions>({ packages: [123] })
  })
})

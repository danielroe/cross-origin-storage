import { assertType, describe, expectTypeOf, it } from 'vitest'
import type { ModuleOptions } from '../src/module'

describe('ModuleOptions', () => {
  it('types packages as a string/RegExp array', () => {
    expectTypeOf<ModuleOptions['packages']>().toEqualTypeOf<Array<string | RegExp>>()
  })

  it('accepts string and RegExp package matchers', () => {
    assertType<ModuleOptions>({ packages: ['vue', /^@vue\//] })
  })

  it('rejects non-string/RegExp matchers', () => {
    // @ts-expect-error packages entries must be string | RegExp
    assertType<ModuleOptions>({ packages: [123] })
  })
})

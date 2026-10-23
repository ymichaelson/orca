import { describe, expect, it } from 'vitest'
import { canonicalJson } from './forge-inbox-canonical-json'

describe('canonicalJson', () => {
  it('sorts keys at every depth and drops undefined properties', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,{"z":1}]},"b":1}'
    )
  })

  it('renders undefined array elements as null, like JSON', () => {
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]')
    expect(canonicalJson({ a: [undefined] })).toBe('{"a":[null]}')
  })

  it.each([
    ['bigint', 10n],
    ['function', () => 1],
    ['symbol', Symbol('s')]
  ])('throws on a %s instead of emitting an ambiguous string', (_name, value) => {
    expect(() => canonicalJson({ a: value })).toThrow(/canonical/)
    expect(() => canonicalJson([value])).toThrow(/canonical/)
  })
})

import { describe, expect, it } from 'vitest'
import { decisionModelTextSchema } from './project-event-decision'

describe('decision model text', () => {
  it('accepts a plain provider model name', () => {
    expect(decisionModelTextSchema.safeParse('jev-latest').success).toBe(true)
    expect(decisionModelTextSchema.safeParse('').success).toBe(true)
  })

  // Why: the name comes from the provider and is shown, so invisible or reordering codepoints
  // could disguise which model actually answered.
  it.each([
    ['zero width space', 'jev\u200blow'],
    ['right-to-left override', 'jev\u202elatest'],
    ['left-to-right isolate', 'jev\u2066latest'],
    ['line separator', 'jev\u2028latest'],
    ['byte order mark', '\ufeffjev'],
    ['C1 control', 'jev\u0085latest'],
    ['newline', 'jev\nlatest'],
    ['delete control', 'jev\u007flatest']
  ])('refuses %s in a model name', (_name, value) => {
    expect(decisionModelTextSchema.safeParse(value).success).toBe(false)
  })
})

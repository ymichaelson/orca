import { describe, expect, it } from 'vitest'
import {
  formatForgeUsernames,
  forgeNewProjectPolicy,
  parseForgeUsernames
} from './forge-inbox-settings-draft'

describe('parseForgeUsernames', () => {
  it('splits on commas and whitespace and keeps the first spelling of a duplicate', () => {
    expect(parseForgeUsernames(' alice, Bob\n  alice ,bob,, ')).toEqual(['alice', 'Bob'])
  })

  it('round-trips through the text field without inventing names', () => {
    const names = ['alice', 'bob.smith']
    expect(parseForgeUsernames(formatForgeUsernames(names))).toEqual(names)
  })
})

describe('forgeNewProjectPolicy', () => {
  it('starts disabled with every event off so nothing runs before the user opts in', () => {
    const policy = forgeNewProjectPolicy('42', 'repo-1', '  ')
    expect(policy.enabled).toBe(false)
    expect(policy.automaticAnalysis).toBe(false)
    expect(Object.values(policy.events)).toEqual([false, false, false, false, false])
    expect(policy.budgets.maxConcurrentRuns).toBe(1)
    expect(policy.workspaceId).toBeUndefined()
  })

  it('keeps an explicit workspace pin', () => {
    expect(forgeNewProjectPolicy('42', 'repo-1', ' wt-7 ').workspaceId).toBe('wt-7')
  })
})

import { describe, expect, it } from 'vitest'
import { isAgentSessionProtectedAnalysis } from './agent-session-protected-analysis'

const marker = (analysisKind: string) => ({
  ownerId: '3f2b8f9e-6f0a-4c8e-9a53-0a4d1c7b2e11',
  instanceId: 'gitlab:gitlab.example.com',
  itemId: '12',
  analysisKind
})

describe('protected analysis marker', () => {
  it.each(['issue', 'merge_request', 'pipeline'])('accepts a %s analysis', (kind) => {
    expect(isAgentSessionProtectedAnalysis(marker(kind))).toBe(true)
  })

  it.each(['project', 'snippet'])(
    'refuses a %s item, which snapshot analysis cannot read',
    (kind) => {
      expect(isAgentSessionProtectedAnalysis(marker(kind))).toBe(false)
    }
  )
})

// A protected analysis transcript carries untrusted MR text. A reader that has not said it draws
// that inertly gets none of it — Session History included, where a row names the chat and a search
// hit offers its text without ever opening it.

import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultSearchHit, AiVaultSearchResponse } from '../../shared/ai-vault-search-types'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  OPENS_EVERY_STRUCTURED_CHAT,
  projectStructuredAiVaultSearchResponse,
  projectStructuredAiVaultSessions
} from './structured-session-ownership'
import {
  installOwnership,
  listResult,
  PROVIDER_SESSION
} from './structured-session-ownership.test-support'

afterEach(() => setStructuredAgentSessionHost(null))

describe('a protected analysis in Session History', () => {
  it('is not listed for a reader that cannot render it inertly', () => {
    installOwnership({ protected: true })

    expect(
      projectStructuredAiVaultSessions(listResult(), OPENS_EVERY_STRUCTURED_CHAT).sessions
    ).toEqual([])
  })

  it('is listed for a reader that renders it inertly', () => {
    installOwnership({ protected: true })

    const projected = projectStructuredAiVaultSessions(
      listResult(),
      OPENS_EVERY_STRUCTURED_CHAT,
      true
    )
    expect(projected.sessions[0]).toMatchObject({
      structuredSession: { sessionId: 'session-alpha' }
    })
  })

  it('still hides an ordinary chat from a reader that cannot open it', () => {
    installOwnership()

    expect(projectStructuredAiVaultSessions(listResult(), () => false, false).sessions).toEqual([])
    expect(
      projectStructuredAiVaultSessions(listResult(), OPENS_EVERY_STRUCTURED_CHAT, false).sessions
    ).toHaveLength(1)
  })

  it('is dropped from indexed hits for a reader that cannot render it inertly', () => {
    installOwnership({ protected: true })

    const response = projectStructuredAiVaultSearchResponse(
      searchResults([searchHit()]),
      OPENS_EVERY_STRUCTURED_CHAT
    )
    expect(response.kind === 'results' && response.hits).toEqual([])
  })

  it('keeps an indexed hit for a reader that renders it inertly', () => {
    installOwnership({ protected: true })

    const response = projectStructuredAiVaultSearchResponse(
      searchResults([searchHit()]),
      OPENS_EVERY_STRUCTURED_CHAT,
      true
    )
    expect(response.kind === 'results' && response.hits).toHaveLength(1)
  })
})

function searchHit(): AiVaultSearchHit {
  return {
    agent: 'codex',
    sessionId: PROVIDER_SESSION,
    title: 'First prompt',
    cwd: '/repo',
    branch: null,
    updatedAt: null,
    messageCount: 1,
    score: 1,
    source: { presence: 'present' },
    evidence: null,
    resumeCommand: `codex resume '${PROVIDER_SESSION}'`
  }
}

function searchResults(hits: AiVaultSearchHit[]): AiVaultSearchResponse {
  return {
    kind: 'results',
    hits,
    page: { cursor: null, hasMore: false },
    generation: 1,
    truncated: { candidates: false, snippets: 0, query: false, freshness: false },
    durationMs: 1
  }
}

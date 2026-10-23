// A protected analysis's transcript is untrusted MR text, and its title and first prompt are more
// of that text. A legacy reader that is not shown the row is not handed either.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { handleAiVaultGetFirstUserPrompt } from './session-first-user-prompt-handler'
import { resolveLocalAiVaultSessionTitles } from './session-title-resolver'
import { installOwnership, PROVIDER_SESSION } from './structured-session-ownership.test-support'

const { readFirstUserPrompt, resolveTitles } = vi.hoisted(() => ({
  readFirstUserPrompt: vi.fn(async () => ({ prompt: 'the first prompt' })),
  resolveTitles: vi.fn(async () => ({ titles: [] }))
}))

vi.mock('./session-scanner-background', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readAiVaultFirstUserPromptInBackground: readFirstUserPrompt,
  resolveAiVaultSessionTitlesInBackground: resolveTitles
}))

const OTHER_SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f61'
const transcriptOf = (sessionId: string) => `/sessions/rollout-${sessionId}.jsonl`

beforeEach(() => {
  readFirstUserPrompt.mockClear()
  resolveTitles.mockClear()
})

afterEach(() => setStructuredAgentSessionHost(null))

describe('a legacy transcript read of a protected analysis', () => {
  it('resolves no title for it while the rows around it still answer', async () => {
    installOwnership({ protected: true })

    await resolveLocalAiVaultSessionTitles([
      {
        agent: 'codex',
        sessionId: PROVIDER_SESSION,
        transcriptPath: transcriptOf(PROVIDER_SESSION)
      },
      { agent: 'codex', sessionId: OTHER_SESSION }
    ])

    expect(resolveTitles).toHaveBeenCalledWith(
      [{ agent: 'codex', sessionId: OTHER_SESSION }],
      undefined
    )
  })

  it('answers no first prompt for it', async () => {
    installOwnership({ protected: true })

    await expect(
      handleAiVaultGetFirstUserPrompt({
        agent: 'codex',
        sessionId: PROVIDER_SESSION,
        filePath: transcriptOf(PROVIDER_SESSION)
      })
    ).resolves.toEqual({ prompt: null })
    expect(readFirstUserPrompt).not.toHaveBeenCalled()
  })

  it('leaves an ordinary chat answering both', async () => {
    installOwnership()

    await resolveLocalAiVaultSessionTitles([
      {
        agent: 'codex',
        sessionId: PROVIDER_SESSION,
        transcriptPath: transcriptOf(PROVIDER_SESSION)
      }
    ])
    expect(resolveTitles).toHaveBeenCalledWith(
      [
        {
          agent: 'codex',
          sessionId: PROVIDER_SESSION,
          transcriptPath: transcriptOf(PROVIDER_SESSION)
        }
      ],
      undefined
    )

    await expect(
      handleAiVaultGetFirstUserPrompt({
        agent: 'codex',
        sessionId: PROVIDER_SESSION,
        filePath: transcriptOf(PROVIDER_SESSION)
      })
    ).resolves.toEqual({ prompt: 'the first prompt' })
  })
})

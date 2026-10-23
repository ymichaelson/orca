import { describe, expect, it } from 'vitest'
import type { AgentSessionProtectedAnalysis } from '../../shared/agent-session-protected-analysis'
import {
  PROTECTED_CLAUDE_NATIVE_HASHES,
  PROTECTED_CLAUDE_PROFILE,
  type ProtectedClaudeLaunchV1
} from '../../shared/agent-session-protected-claude-launch'
import {
  createForgeProtectedAnalysisTurn,
  type ForgeProtectedAnalysisFounding,
  type ForgeProtectedAnalysisOpenRequest,
  type ForgeProtectedAnalysisTurnDeps
} from './forge-inbox-protected-turn'

const SUBJECT: AgentSessionProtectedAnalysis = {
  ownerId: '6f1c1f0e-2a5c-4b1e-9b0e-0a1b2c3d4e5f',
  instanceId: 'instance-1',
  itemId: '42',
  analysisKind: 'merge_request'
}
const PRIVATE_ROOT = '/private/orca/forge-protected-analysis/session-1'
const FOUNDING: ForgeProtectedAnalysisFounding = {
  protectedClaudeLaunch: {
    version: 1,
    profile: PROTECTED_CLAUDE_PROFILE,
    executable: {
      path: '/usr/local/lib/claude/claude',
      platform: 'darwin-arm64',
      sha256: PROTECTED_CLAUDE_NATIVE_HASHES['darwin-arm64']
    },
    privateRoot: PRIVATE_ROOT,
    auth: {
      kind: 'saved-agent-env',
      settingsKey: 'claude',
      credentialKey: 'ANTHROPIC_API_KEY',
      baseUrl: 'https://api.anthropic.com'
    }
  } satisfies ProtectedClaudeLaunchV1,
  accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: `${PRIVATE_ROOT}/config` },
  options: { model: 'claude-protected-analysis' }
}

function turnWith(deps: {
  foundFor?: ForgeProtectedAnalysisTurnDeps['foundFor']
  openSession?: ForgeProtectedAnalysisTurnDeps['openSession']
}) {
  return createForgeProtectedAnalysisTurn({
    foundFor: deps.foundFor ?? (async () => FOUNDING),
    openSession: deps.openSession ?? (async () => ({ sendTurn: async () => '{"summary":"s"}' }))
  })
}

function request(signal = new AbortController().signal, bound: string[] = []) {
  return {
    prompt: 'analyse this',
    signal,
    subject: SUBJECT,
    onSession: (sessionId: string) => bound.push(sessionId)
  }
}

describe('forge protected analysis turn', () => {
  it('founds, durably binds, then sends from the private work directory', async () => {
    const events: string[] = []
    let opened: ForgeProtectedAnalysisOpenRequest | undefined
    const turn = turnWith({
      foundFor: async ({ sessionId, subject }) => {
        events.push('found')
        expect(subject).toEqual(SUBJECT)
        expect(sessionId).toMatch(/^[A-Za-z0-9_-]{8,128}$/)
        return FOUNDING
      },
      openSession: async (input) => {
        events.push('open')
        opened = input
        return {
          sendTurn: async (prompt) => {
            events.push('send')
            expect(prompt).toBe('analyse this')
            return '{"summary":"One nit."}'
          }
        }
      }
    })
    const bound: string[] = []

    await expect(turn(request(undefined, bound))).resolves.toEqual({
      kind: 'reply',
      text: '{"summary":"One nit."}'
    })
    expect(events).toEqual(['found', 'open', 'send'])
    expect(opened?.launchDirectory).toBe(`${PRIVATE_ROOT}/work`)
    expect(opened?.founding).toBe(FOUNDING)
    expect(bound).toHaveLength(1)
  })

  it('binds the session before it is opened, because opening is what starts the agent', async () => {
    const bound: string[] = []
    const turn = turnWith({
      openSession: async () => {
        expect(bound).toHaveLength(1)
        return { sendTurn: async () => '{"summary":"s"}' }
      }
    })

    await turn(request(undefined, bound))
    expect(bound[0]).toBeTruthy()
  })

  it('founds nothing when the run is already aborted', async () => {
    let founded = false
    const stopped = new AbortController()
    stopped.abort()
    const turn = turnWith({
      foundFor: async () => {
        founded = true
        return FOUNDING
      }
    })

    await expect(turn(request(stopped.signal))).resolves.toEqual({ kind: 'unknown' })
    expect(founded).toBe(false)
  })

  it('stops before opening a session when the run is aborted during founding', async () => {
    const stopped = new AbortController()
    let opened = false
    const bound: string[] = []
    const turn = turnWith({
      foundFor: async () => {
        stopped.abort()
        return FOUNDING
      },
      openSession: async () => {
        opened = true
        return { sendTurn: async () => '{"summary":"s"}' }
      }
    })

    await expect(turn(request(stopped.signal, bound))).resolves.toEqual({ kind: 'unknown' })
    expect(opened).toBe(false)
    expect(bound).toEqual([])
  })

  it('sends nothing when the protected founding is unavailable', async () => {
    let opened = false
    const bound: string[] = []
    const turn = turnWith({
      foundFor: async () => {
        throw new Error('protected_claude_founding_unavailable')
      },
      openSession: async () => {
        opened = true
        return { sendTurn: async () => '{"summary":"s"}' }
      }
    })

    await expect(turn(request(undefined, bound))).rejects.toThrow(
      /protected_claude_founding_unavailable/
    )
    expect(opened).toBe(false)
    expect(bound).toEqual([])
  })

  it('refuses a founding whose config directory escaped the private root', async () => {
    let opened = false
    const bound: string[] = []
    const turn = turnWith({
      foundFor: async () => ({
        ...FOUNDING,
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/Users/someone/.claude' }
      }),
      openSession: async () => {
        opened = true
        return { sendTurn: async () => '{"summary":"s"}' }
      }
    })

    await expect(turn(request(undefined, bound))).rejects.toThrow(
      /protected_claude_founding_unavailable/
    )
    expect(opened).toBe(false)
    expect(bound).toEqual([])
  })

  it('reports a reply the session could not prove as unknown', async () => {
    const bound: string[] = []
    const turn = turnWith({
      openSession: async () => ({ sendTurn: async () => null })
    })

    await expect(turn(request(undefined, bound))).resolves.toEqual({ kind: 'unknown' })
    expect(bound).toHaveLength(1)
  })
})

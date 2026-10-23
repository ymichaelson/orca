import { afterEach, describe, expect, it } from 'vitest'
import {
  PROTECTED_CLAUDE_NATIVE_HASHES,
  PROTECTED_CLAUDE_PROFILE,
  protectedClaudeLaunchSchema
} from '../../shared/agent-session-protected-claude-launch'
import type { AgentSessionProtectedAnalysis } from '../../shared/agent-session-protected-analysis'
import {
  createForgeAnalysisFoundFor,
  createForgeInboxAnalysisTurn,
  resolveForgeAnalysisLaunch
} from './forge-inbox-analysis-launch'
import {
  createWorkerRig,
  mergeRequestHookBody,
  type WorkerRig
} from './forge-inbox-webhook-worker-test-kit'

const PRIVATE_ROOT = '/private/tmp/forge-launch-test'

function founding(model: string) {
  return {
    protectedClaudeLaunch: protectedClaudeLaunchSchema.parse({
      version: 1,
      profile: PROTECTED_CLAUDE_PROFILE,
      executable: {
        path: '/private/tmp/claude-2.1.302',
        platform: 'darwin-arm64',
        sha256: PROTECTED_CLAUDE_NATIVE_HASHES['darwin-arm64']
      },
      privateRoot: PRIVATE_ROOT,
      auth: {
        kind: 'saved-agent-env',
        settingsKey: 'claude',
        credentialKey: 'ANTHROPIC_API_KEY',
        baseUrl: 'https://api.example.com'
      }
    }),
    accountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: `${PRIVATE_ROOT}/config` },
    options: { model }
  }
}

function subjectFor(rig: WorkerRig): AgentSessionProtectedAnalysis {
  const item = rig.ledger.getItem({}, 1)
  if (!item) {
    throw new Error('missing item')
  }
  return {
    ownerId: item.hostId,
    instanceId: item.instanceId,
    itemId: String(item.id),
    analysisKind: item.kind
  }
}

describe('forge analysis launch policy', () => {
  let rig: WorkerRig
  afterEach(() => rig.dispose())

  async function queuedReviewRequest(options: Parameters<typeof createWorkerRig>[0] = {}) {
    rig = createWorkerRig(options)
    rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
    await rig.worker().drainOnce()
    return subjectFor(rig)
  }

  it('launches with the project policy that is current now', async () => {
    const subject = await queuedReviewRequest()

    expect(resolveForgeAnalysisLaunch(rig.ledger, subject)).toEqual({
      instanceId: 'gitlab-main',
      projectId: '42',
      workspaceId: null,
      agentId: 'agent',
      model: 'model',
      budgets: {
        timeoutSeconds: 600,
        maxInputTokens: 100_000,
        maxOutputTokens: 8_000,
        maxRunsPerHour: 12,
        maxConcurrentRuns: 1
      }
    })
  })

  it('carries the configured workspace', async () => {
    const subject = await queuedReviewRequest({ project: { workspaceId: 'ws-1' } })

    expect(resolveForgeAnalysisLaunch(rig.ledger, subject).workspaceId).toBe('ws-1')
  })

  it('refuses a subject whose kind does not match the item', async () => {
    const subject = await queuedReviewRequest()

    expect(() =>
      resolveForgeAnalysisLaunch(rig.ledger, { ...subject, analysisKind: 'issue' })
    ).toThrow('forge_analysis_subject_mismatch')
  })

  it('refuses a project that was turned off after the run was queued', async () => {
    const subject = await queuedReviewRequest()
    rig.reconfigure({ enabled: false })

    expect(() => resolveForgeAnalysisLaunch(rig.ledger, subject)).toThrow(
      'forge_analysis_policy_disabled'
    )
  })

  it('prepares the founding for exactly the policy model', async () => {
    const subject = await queuedReviewRequest()
    const prepared: { sessionId: string; agentId: string; model: string }[] = []
    const foundFor = createForgeAnalysisFoundFor({
      ledger: rig.ledger,
      prepare: async ({ sessionId, launch }) => {
        prepared.push({ sessionId, agentId: launch.agentId, model: launch.model })
        return founding(launch.model)
      }
    })

    const result = await foundFor({ sessionId: 'session-1', subject })

    expect(prepared).toEqual([{ sessionId: 'session-1', agentId: 'agent', model: 'model' }])
    expect(result.options.model).toBe('model')
  })

  it('refuses a founding prepared for another model', async () => {
    const subject = await queuedReviewRequest()
    const foundFor = createForgeAnalysisFoundFor({
      ledger: rig.ledger,
      prepare: async () => founding('other-model')
    })

    await expect(foundFor({ sessionId: 'session-1', subject })).rejects.toThrow(
      'forge_analysis_founding_model_mismatch'
    )
  })

  it('binds the session the founding was prepared for', async () => {
    const subject = await queuedReviewRequest()
    const opened: string[] = []
    const turn = createForgeInboxAnalysisTurn({
      ledger: rig.ledger,
      prepare: async ({ launch }) => founding(launch.model),
      openSession: async ({ sessionId }) => {
        opened.push(sessionId)
        return { sendTurn: async () => '{"summary":"ok","concerns":[]}' }
      }
    })

    const bound: string[] = []
    const result = await turn({
      prompt: 'prompt',
      signal: new AbortController().signal,
      subject,
      onSession: (sessionId) => bound.push(sessionId)
    })

    expect(result).toEqual({ kind: 'reply', text: '{"summary":"ok","concerns":[]}' })
    expect(opened).toHaveLength(1)
    expect(bound).toEqual(opened)
  })

  it('opens no session for a project turned off before the turn', async () => {
    const subject = await queuedReviewRequest()
    rig.reconfigure({ automaticAnalysis: false })
    const opened: string[] = []
    const turn = createForgeInboxAnalysisTurn({
      ledger: rig.ledger,
      prepare: async ({ launch }) => founding(launch.model),
      openSession: async ({ sessionId }) => {
        opened.push(sessionId)
        return { sendTurn: async () => '{"summary":"ok","concerns":[]}' }
      }
    })

    await expect(
      turn({
        prompt: 'prompt',
        signal: new AbortController().signal,
        subject,
        onSession: () => undefined
      })
    ).rejects.toThrow('forge_analysis_policy_disabled')
    expect(opened).toEqual([])
  })
})

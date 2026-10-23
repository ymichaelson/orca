import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createForgeAnalysisRunner } from './forge-inbox-analysis-runner'
import type { GitlabSnapshot } from './forge-inbox-gitlab-snapshot'
import type { GitlabSnapshotSubject } from './forge-inbox-gitlab-snapshot-relevance'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeObservationInput } from './forge-inbox-observation'
import {
  createWebhookHarness,
  INSTANCE_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }

function snapshot(overrides: Partial<GitlabSnapshot> = {}): GitlabSnapshot {
  return {
    title: 'Fresh title from GitLab',
    itemState: 'opened',
    versionToken: 'head-a',
    completeness: { complete: true, notes: true, diffs: true, ci: true },
    subject: null,
    ...overrides
  }
}

function mergeRequestSubject(sha: string): GitlabSnapshotSubject {
  return {
    kind: 'merge_request',
    mergeRequest: {
      iid: 7,
      state: 'opened',
      title: 'Fresh title from GitLab',
      description: '',
      target_branch: 'main',
      source_branch: 'topic',
      source_project_id: 42,
      target_project_id: 42,
      draft: false,
      sha,
      diff_refs: { base_sha: 'b'.repeat(40), head_sha: sha, start_sha: 'c'.repeat(40) },
      author: 'alice',
      reviewers: ['alice'],
      assignees: [],
      updated_at: '2026-10-01T12:00:00Z',
      headPipeline: null
    }
  }
}

describe('forge analysis runner', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let runId: number

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(
      ledger,
      webhookConfig([
        webhookInstance({
          projects: [
            {
              projectId: '42',
              repoId: 'repo-1',
              workspaceId: 'ws-1',
              agentId: 'codex',
              model: 'gpt-fake',
              enabled: true,
              automaticAnalysis: true
            }
          ]
        })
      ])
    )
    const input: ForgeObservationInput = {
      hostId: 'host-a',
      ...SCOPE,
      projectId: '42',
      kind: 'merge_request',
      iid: 7,
      dedupeKey: 'delivery-1',
      eventKind: 'merge_request.review_requested',
      payload: { token: 'head-a' },
      versionToken: 'head-a',
      queueRun: { reason: 'review-request' }
    }
    const result = ledger.ingestObservation(input, ledger.getConfig().configRevision, 0)
    if (!result.ok || result.duplicate || result.runId === null) {
      throw new Error(`unexpected observation outcome ${JSON.stringify(result)}`)
    }
    runId = result.runId
  })
  afterEach(() => harness.dispose())

  function runnerWith(
    deps: Pick<Parameters<typeof createForgeAnalysisRunner>[0], 'readSnapshot' | 'turn'>
  ) {
    return createForgeAnalysisRunner({ ledger, scope: SCOPE, ...deps })
  }

  function start(bindSession: (sessionId: string) => void = () => {}) {
    const run = ledger.getRun(runId)
    if (!run) {
      throw new Error('run missing')
    }
    return {
      run,
      signal: new AbortController().signal,
      bindSession
    }
  }

  it('sends the freshly read snapshot and returns the parsed reply', async () => {
    let prompt = ''
    const runner = runnerWith({
      readSnapshot: async (item) => {
        expect(item).toMatchObject({ kind: 'merge_request', iid: 7, projectId: '42' })
        return snapshot()
      },
      turn: async (request) => {
        prompt = request.prompt
        expect(request.subject).toEqual({
          ownerId: 'host-a',
          instanceId: INSTANCE_ID,
          itemId: expect.stringMatching(/^[1-9][0-9]*$/),
          analysisKind: 'merge_request'
        })
        return { kind: 'reply', text: '{"summary":"One nit.","concerns":["no test"]}' }
      }
    })

    await expect(runner(start())).resolves.toEqual({
      kind: 'analysed',
      result: { summary: 'One nit.', concerns: ['no test'] }
    })
    expect(prompt).toContain('"versionToken":"head-a"')
    expect(prompt).toContain('Fresh title from GitLab')
    expect(prompt).toContain('"reason":"review-request"')
  })

  it('binds the session the turn reports before the reply is returned', async () => {
    const bound: string[] = []
    const runner = runnerWith({
      readSnapshot: async () => snapshot(),
      turn: async ({ onSession }) => {
        onSession('session-1')
        return { kind: 'reply', text: '{"summary":"Fine.","concerns":[]}' }
      }
    })

    await runner(start((sessionId) => bound.push(sessionId)))
    expect(bound).toEqual(['session-1'])
  })

  it('does not analyse a context that moved after the run was queued', async () => {
    let sent = false
    const runner = runnerWith({
      readSnapshot: async () => snapshot({ versionToken: 'head-b' }),
      turn: async () => {
        sent = true
        return { kind: 'reply', text: '{"summary":"Fine.","concerns":[]}' }
      }
    })

    await expect(runner(start())).resolves.toEqual({ kind: 'unknown' })
    expect(sent).toBe(false)
  })

  it('sends nothing when the run is already aborted', async () => {
    let read = false
    let sent = false
    const runner = runnerWith({
      readSnapshot: async () => {
        read = true
        return snapshot()
      },
      turn: async () => {
        sent = true
        return { kind: 'reply', text: '{"summary":"Fine.","concerns":[]}' }
      }
    })
    const stopped = new AbortController()
    stopped.abort()

    await expect(runner({ ...start(), signal: stopped.signal })).resolves.toEqual({
      kind: 'unknown'
    })
    expect(read).toBe(false)
    expect(sent).toBe(false)
  })

  it('stops when the run is aborted while its snapshot is being read', async () => {
    const stopped = new AbortController()
    let sent = false
    const runner = runnerWith({
      readSnapshot: async () => {
        stopped.abort()
        return snapshot()
      },
      turn: async () => {
        sent = true
        return { kind: 'reply', text: '{"summary":"Fine.","concerns":[]}' }
      }
    })

    await expect(runner({ ...start(), signal: stopped.signal })).resolves.toEqual({
      kind: 'unknown'
    })
    expect(sent).toBe(false)
  })

  it('refuses a run whose item is not in this owner scope', async () => {
    const other = createForgeAnalysisRunner({
      ledger,
      scope: { instanceId: 'another-instance' },
      readSnapshot: async () => snapshot(),
      turn: async () => ({ kind: 'reply', text: '{"summary":"Fine.","concerns":[]}' })
    })

    await expect(other(start())).rejects.toThrow(/forge_analysis_item_missing/)
  })

  it('passes an outcome the turn could not prove through as unknown', async () => {
    const bound: string[] = []
    const runner = runnerWith({
      readSnapshot: async () => snapshot(),
      turn: async ({ onSession }) => {
        onSession('session-2')
        return { kind: 'unknown' }
      }
    })

    await expect(runner(start((sessionId) => bound.push(sessionId)))).resolves.toEqual({
      kind: 'unknown'
    })
    expect(bound).toEqual(['session-2'])
  })

  it('reports the observed head a draft may be approved against', async () => {
    const head = 'a'.repeat(40)
    const runner = runnerWith({
      readSnapshot: async () => snapshot({ subject: mergeRequestSubject(head) }),
      turn: async () => ({
        kind: 'reply',
        text: '{"summary":"Fine.","concerns":[],"draft":"Please add a test."}'
      })
    })

    await expect(runner(start())).resolves.toEqual({
      kind: 'analysed',
      result: { summary: 'Fine.', concerns: [], draft: 'Please add a test.' },
      commentDraft: { headSha: head }
    })
  })

  it('binds no head when the reply carried no draft', async () => {
    const runner = runnerWith({
      readSnapshot: async () => snapshot({ subject: mergeRequestSubject('a'.repeat(40)) }),
      turn: async () => ({ kind: 'reply', text: '{"summary":"Fine.","concerns":[]}' })
    })

    await expect(runner(start())).resolves.toEqual({
      kind: 'analysed',
      result: { summary: 'Fine.', concerns: [] }
    })
  })

  it('surfaces a reply that breaks the contract instead of recording it', async () => {
    const runner = runnerWith({
      readSnapshot: async () => snapshot(),
      turn: async () => ({ kind: 'reply', text: 'Looks fine to me.' })
    })

    await expect(runner(start())).rejects.toThrow(/forge_analysis_reply_malformed/)
  })
})

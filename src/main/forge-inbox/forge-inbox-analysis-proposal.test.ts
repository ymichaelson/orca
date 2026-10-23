import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeItemKind, ForgeRun } from '../../shared/forge-inbox-types'
import { createForgeAnalysisProposal } from './forge-inbox-analysis-proposal'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeObservationInput } from './forge-inbox-observation'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const HEAD = 'a'.repeat(40)
const BODY = 'Please add a test for the retry path.'

describe('forge analysis proposals', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(
      ledger,
      webhookConfig([
        webhookInstance({
          projects: [
            {
              projectId: PROJECT_ID,
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
  })
  afterEach(() => harness.dispose())

  function queue(kind: ForgeItemKind, iid: number): number {
    const input: ForgeObservationInput = {
      hostId: 'host-a',
      ...SCOPE,
      projectId: PROJECT_ID,
      kind,
      iid,
      dedupeKey: `${kind}-${iid}`,
      eventKind: `${kind}.event`,
      payload: { token: 'head-a' },
      versionToken: 'head-a',
      queueRun: { reason: 'review-request' }
    }
    const result = ledger.ingestObservation(input, ledger.getConfig().configRevision, 0)
    if (!result.ok || result.duplicate || result.runId === null) {
      throw new Error(`unexpected observation outcome ${JSON.stringify(result)}`)
    }
    return result.runId
  }

  function claim(runId: number): ForgeRun {
    const run = ledger.claimNextRunnableRun(SCOPE, { maxConcurrentRuns: 4 })
    if (!run || run.id !== runId) {
      throw new Error('unexpected run claim')
    }
    return run
  }

  function proposals(run: ForgeRun) {
    return ledger.getItemDetail(SCOPE, run.itemId, 'client-1')?.proposals ?? []
  }

  it('turns an analysed draft into one pending comment bound to the observed head', () => {
    const run = claim(queue('merge_request', 7))
    createForgeAnalysisProposal(ledger)({ run, headSha: HEAD, body: BODY })

    expect(proposals(run)).toMatchObject([
      {
        runId: run.id,
        revision: run.revision,
        policyGeneration: run.policyGeneration,
        status: 'pending',
        body: {
          kind: 'comment',
          target: { instanceId: INSTANCE_ID, projectId: PROJECT_ID, kind: 'merge_request', iid: 7 },
          headSha: HEAD,
          body: BODY
        }
      }
    ])
  })

  it('leaves no proposal for blank text', () => {
    const run = claim(queue('merge_request', 7))
    createForgeAnalysisProposal(ledger)({ run, headSha: HEAD, body: '  \n\t ' })

    expect(proposals(run)).toEqual([])
  })

  it('never binds a merge request comment without the head the analysis saw', () => {
    const run = claim(queue('merge_request', 7))
    createForgeAnalysisProposal(ledger)({ run, headSha: null, body: BODY })

    expect(proposals(run)).toEqual([])
  })

  it('does not propose under rules revoked before the draft was ready', () => {
    const run = claim(queue('merge_request', 7))
    ledger.bumpPolicyGeneration({ instanceId: INSTANCE_ID, projectId: PROJECT_ID })
    createForgeAnalysisProposal(ledger)({ run, headSha: HEAD, body: BODY })

    expect(proposals(run)).toEqual([])
  })

  it('comments on an issue without a head to bind', () => {
    const run = claim(queue('issue', 9))
    createForgeAnalysisProposal(ledger)({ run, headSha: null, body: BODY })

    expect(proposals(run)).toMatchObject([
      {
        status: 'pending',
        body: {
          target: { kind: 'issue', iid: 9 },
          headSha: null,
          body: BODY
        }
      }
    ])
  })

  it('never proposes a comment for a pipeline item', () => {
    const run = claim(queue('pipeline', 3))
    createForgeAnalysisProposal(ledger)({ run, headSha: HEAD, body: BODY })

    expect(proposals(run)).toEqual([])
  })
})

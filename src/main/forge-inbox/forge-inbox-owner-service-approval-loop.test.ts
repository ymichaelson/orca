import { afterEach, describe, expect, it } from 'vitest'
import {
  forgeCommentMarker,
  hashForgeCommentDraft,
  parseForgeCommentDraft
} from './forge-inbox-comment-draft'
import { mergeRequestHookBody, SHA_A, SHA_B } from './forge-inbox-gitlab-fake-server'
import {
  createOwnerFixture,
  freePort,
  listenerOn,
  postHook,
  provision,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'
import { INSTANCE_ID } from './forge-inbox-webhook-test-harness'

const ANALYSIS_PROJECT = { automaticAnalysis: true, agentId: 'claude', model: 'claude-test' }
const DRAFT = 'Please add a test for the retry path.'
const SCOPE = { instanceId: INSTANCE_ID }

type OwnerService = ReturnType<OwnerFixture['service']>

describe('forge inbox approval loop', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  async function runningService(): Promise<{ service: OwnerService; port: number }> {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service({
      analyse:
        () =>
        async ({ bindSession }) => {
          bindSession('session-1')
          return {
            kind: 'analysed',
            result: { summary: 'Looks fine.', concerns: ['no test'], draft: DRAFT },
            commentDraft: { headSha: SHA_A }
          }
        }
    })
    await service.start()
    await provision(service, listenerOn(port), { project: ANALYSIS_PROJECT })
    const stored = await service.setCredential({
      instanceId: INSTANCE_ID,
      kind: 'api-write',
      secret: 'glpat-owner-write',
      expectedRevision: service.getConfig().configRevision
    })
    if (!stored.ok) {
      throw new Error(`credential rejected: ${stored.reason}`)
    }
    return { service, port }
  }

  function pendingApproval(): {
    scope: { instanceId: string }
    proposalId: number
    expectedHash: string
    expectedRevision: number
    expectedPolicyGeneration: number
  } {
    const [row] = fx.rows(
      'SELECT id, revision, policy_generation, status, body_json FROM proposals ORDER BY id'
    )
    if (!row || row.status !== 'pending') {
      throw new Error('expected one pending proposal')
    }
    const draft = parseForgeCommentDraft(JSON.parse(String(row.body_json)))
    if (!draft) {
      throw new Error('stored proposal is not a comment draft')
    }
    return {
      scope: SCOPE,
      proposalId: Number(row.id),
      expectedHash: hashForgeCommentDraft(draft),
      expectedRevision: Number(row.revision),
      expectedPolicyGeneration: Number(row.policy_generation)
    }
  }

  it('publishes the analysis draft as exactly one comment once the owner approves it', async () => {
    const { service, port } = await runningService()

    const ack = await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    expect(ack.status).toBe(202)
    await service.settled()

    const approval = pendingApproval()
    const approved = await service.approveComment(approval, new AbortController().signal)

    expect(approved).toMatchObject({ ok: true })
    expect(fx.gitlab.writes).toHaveLength(1)
    expect(fx.gitlab.writes[0]?.path).toBe('/merge_requests/7/notes')
    expect(JSON.parse(fx.gitlab.writes[0]?.body ?? '{}')).toEqual({
      body: `${DRAFT}\n\n${forgeCommentMarker(approval.proposalId, approval.expectedHash)}`
    })
    expect(fx.rows('SELECT state FROM receipts')).toEqual([{ state: 'applied' }])
  })

  it('refuses the approval and posts nothing when the merge request head moved', async () => {
    const { service, port } = await runningService()
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await service.settled()
    fx.gitlab.state.mergeRequest.sha = SHA_B

    const refused = await service.approveComment(pendingApproval(), new AbortController().signal)

    expect(refused).toEqual({ ok: false, reason: 'head-moved' })
    expect(fx.gitlab.writes).toEqual([])
    expect(fx.rows('SELECT status FROM proposals')).toEqual([{ status: 'stale' }])
  })

  it('consumes the approval once, so a second approval posts nothing more', async () => {
    const { service, port } = await runningService()
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await service.settled()
    const approval = pendingApproval()

    const first = await service.approveComment(approval, new AbortController().signal)
    const second = await service.approveComment(approval, new AbortController().signal)

    expect(first).toMatchObject({ ok: true })
    expect(second).toEqual({ ok: false, reason: 'not-pending' })
    expect(fx.gitlab.writes).toHaveLength(1)
  })

  it('keeps the pending approval across a host restart', async () => {
    const { service, port } = await runningService()
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await service.settled()
    const approval = pendingApproval()
    await service.stop()

    const reopened = fx.service()
    await reopened.start()
    const approved = await reopened.approveComment(approval, new AbortController().signal)

    expect(approved).toMatchObject({ ok: true })
    expect(fx.gitlab.writes).toHaveLength(1)
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { buildForgeCommentDraft } from './forge-inbox-comment-draft'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  buildForgePatchDraft,
  hashForgePatchDraft,
  parseForgePatchDraft,
  sha256OfContent
} from './forge-inbox-patch-draft'
import {
  finishForgePatchRequest,
  type ForgePatchRequestFailureReason,
  type ForgePatchRequestOutcome
} from './forge-inbox-patch-request-completion'
import type { ForgePatchRequest, ForgePatchRequestClaimInput } from './forge-inbox-patch-requests'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const PROJECT = { instanceId: INSTANCE_ID, projectId: PROJECT_ID }
const INTENT = { message: 'please fix the flaky test', paths: ['src/feature.ts'] }
const BASE_SHA = 'a'.repeat(40)

function config(projectOverrides: Record<string, unknown> = {}) {
  return webhookConfig([
    webhookInstance({
      projects: [
        {
          projectId: PROJECT_ID,
          repoId: 'repo-1',
          agentId: 'codex',
          model: 'gpt-fake',
          enabled: true,
          ...projectOverrides
        }
      ]
    })
  ])
}

function draftFor(
  options: {
    path?: string
    content?: string
    instanceId?: string
    projectId?: string
    baseSha?: string
    branch?: string
  } = {}
) {
  const content = options.content ?? 'export const value = 1\n'
  const input = {
    target: {
      instanceId: options.instanceId ?? INSTANCE_ID,
      projectId: options.projectId ?? PROJECT_ID
    },
    baseSha: options.baseSha ?? BASE_SHA,
    branch: options.branch ?? 'feature/work',
    operations: [
      {
        op: 'update' as const,
        path: options.path ?? 'src/feature.ts',
        baseSha256: sha256OfContent('export const value = 0\n'),
        content,
        resultSha256: sha256OfContent(content)
      }
    ]
  }
  const built = buildForgePatchDraft(input)
  if (!built.ok) {
    throw new Error(`draft rejected: ${built.reason}`)
  }
  return { input, draft: built.draft, hash: built.hash }
}

describe('forge inbox patch request completion', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let sequence: number

  function withDb<T>(run: (db: InstanceType<typeof Database>) => T): T {
    const db = new Database(harness.dbPath)
    try {
      return run(db)
    } finally {
      db.close()
    }
  }

  const requestRows = () =>
    withDb((db) => db.prepare('SELECT * FROM patch_requests ORDER BY id').all())
  const proposalRows = () => withDb((db) => db.prepare('SELECT * FROM proposals ORDER BY id').all())
  const rawRequest = (id: number) =>
    withDb((db) => db.prepare('SELECT * FROM patch_requests WHERE id = ?').get(id))
  const changes = () => ledger.listChanges(SCOPE, { afterSeq: 0 }).changes

  const claim = (runId: number, overrides: Partial<ForgePatchRequestClaimInput> = {}) =>
    ledger.claimPatchRequest({
      scope: SCOPE,
      callerKey: 'client-1',
      operationId: 'op-1',
      runId,
      intent: INTENT,
      ...overrides
    })

  function claimedRequest(
    runId: number,
    operationId = 'op-1',
    callerKey = 'client-1'
  ): ForgePatchRequest {
    const result = claim(runId, { operationId, callerKey })
    if (result.kind !== 'claimed') {
      throw new Error(`claim was refused: ${result.kind}`)
    }
    return result.request
  }

  const finish = (
    request: ForgePatchRequest,
    outcome: unknown,
    overrides: Partial<{
      callerKey: string
      scope: { instanceId?: string }
      requestId: number
      expectedRequestDigest: string
    }> = {}
  ) =>
    ledger.finishPatchRequest({
      scope: SCOPE,
      callerKey: 'client-1',
      requestId: request.id,
      expectedRequestDigest: request.requestDigest,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: malformed outcomes are deliberately passed to exercise runtime validation.
      outcome: outcome as ForgePatchRequestOutcome,
      ...overrides
    })

  function queueRun(
    options: { iid?: number; token?: string; kind?: 'merge_request' | 'issue' } = {}
  ) {
    const order = ++sequence
    const result = ledger.ingestEvent({
      hostId: ledger.hostId,
      ...PROJECT,
      kind: options.kind ?? 'merge_request',
      iid: options.iid ?? 7,
      dedupeKey: `delivery-${order}`,
      eventKind: 'merge_request.updated',
      payload: null,
      versionToken: options.token ?? `head-${order}`,
      title: 'Add thing',
      itemState: 'opened',
      sourceOrder: order,
      queueRun: { reason: 'review-request' }
    })
    if (result.duplicate || result.runId === null) {
      throw new Error('no run queued')
    }
    return { runId: result.runId, itemId: result.itemId }
  }

  /** A run that finished an analysis and persisted the session a patch request continues. */
  function completedRun(
    options: {
      state?: 'succeeded' | 'awaiting-approval'
      iid?: number
      token?: string
    } = {}
  ) {
    const { runId, itemId } = queueRun(options)
    const claimed = ledger.claimNextQueuedRun(SCOPE)
    if (!claimed || claimed.id !== runId) {
      throw new Error('queued run was not claimed')
    }
    const bound = ledger.bindRunSession(runId, `session-${runId}`)
    if (!bound) {
      throw new Error('session was not bound')
    }
    const transitioned = ledger.transitionRun(runId, { to: options.state ?? 'succeeded' })
    if (!transitioned.ok) {
      throw new Error(`run did not settle: ${transitioned.reason}`)
    }
    return { runId, itemId, sessionId: `session-${runId}` }
  }

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger, config())
    sequence = 0
  })
  afterEach(() => harness.dispose())

  it('completes a succeeded run with one immutable pending patch while the run stays terminal', () => {
    const { runId, itemId } = completedRun()
    const request = claimedRequest(runId)
    const expected = draftFor()
    const runGeneration = ledger.getRun(runId)?.generation

    const result = finish(request, {
      kind: 'success',
      draft: expected.draft,
      expectedDraftHash: expected.hash
    })

    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') {
      throw new Error('finish was refused')
    }
    expect(result.request).toMatchObject({
      id: request.id,
      state: 'succeeded',
      reasonCode: null,
      proposalId: result.proposal?.id
    })
    expect(result.proposal).toMatchObject({
      runId,
      itemId,
      revision: request.revision,
      policyGeneration: request.policyGeneration,
      status: 'pending',
      resolvedAt: null
    })
    expect(result.proposal?.body).toEqual(expected.draft)
    const stored = parseForgePatchDraft(result.proposal?.body)
    expect(stored).not.toBeNull()
    expect(stored && hashForgePatchDraft(stored)).toBe(expected.hash)

    const raw = rawRequest(request.id)
    expect(raw?.state).toBe('succeeded')
    expect(raw?.proposal_id).toBe(result.proposal?.id)
    expect(
      changes().filter(
        (change) =>
          change.entity === 'proposal' &&
          change.entityId === result.proposal?.id &&
          change.change === 'pending'
      )
    ).toHaveLength(1)

    // Completing a follow-up never rewrites the terminal analysis run.
    expect(ledger.getRun(runId)).toMatchObject({ state: 'succeeded', generation: runGeneration })
    expect(proposalRows()).toHaveLength(1)
  })

  it('completes a run that is awaiting approval', () => {
    const { runId } = completedRun({ state: 'awaiting-approval' })
    const request = claimedRequest(runId)
    const expected = draftFor()

    const result = finish(request, {
      kind: 'success',
      draft: expected.draft,
      expectedDraftHash: expected.hash
    })

    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') {
      throw new Error('finish was refused')
    }
    expect(result.request.state).toBe('succeeded')
    expect(ledger.getRun(runId)?.state).toBe('awaiting-approval')
    expect(proposalRows()).toHaveLength(1)
  })

  it('replays a terminal outcome without a second proposal even when the inputs change', () => {
    const { runId } = completedRun()
    const request = claimedRequest(runId)
    const expected = draftFor()
    const first = finish(request, {
      kind: 'success',
      draft: expected.draft,
      expectedDraftHash: expected.hash
    })
    if (first.kind !== 'completed' || !first.proposal) {
      throw new Error('finish was refused')
    }
    const changed = draftFor({ path: 'src/another.ts', content: 'different\n' })
    const changeCount = changes().length

    const replay = finish(request, {
      kind: 'success',
      draft: changed.draft,
      expectedDraftHash: changed.hash
    })
    // Even a contradictory failed outcome replays the stored success.
    const conflicting = finish(request, { kind: 'failed', reason: 'producer-failed' })

    for (const result of [replay, conflicting]) {
      expect(result).toMatchObject({
        kind: 'completed',
        request: { id: first.request.id, state: 'succeeded', proposalId: first.proposal.id },
        proposal: { id: first.proposal.id, status: 'pending' }
      })
    }
    expect(proposalRows()).toHaveLength(1)
    expect(changes()).toHaveLength(changeCount)

    // A request that failed first also replays its failure rather than inventing a patch.
    const failedRequest = claimedRequest(runId, 'op-2')
    expect(finish(failedRequest, { kind: 'failed', reason: 'producer-failed' }).kind).toBe(
      'completed'
    )
    const failedReplay = finish(failedRequest, {
      kind: 'success',
      draft: expected.draft,
      expectedDraftHash: expected.hash
    })
    expect(failedReplay).toMatchObject({
      kind: 'completed',
      request: { id: failedRequest.id, state: 'failed', reasonCode: 'producer-failed' },
      proposal: null
    })
    expect(proposalRows()).toHaveLength(1)
  })

  it('refuses a wrong caller, instance scope or request id without touching the request', () => {
    const { runId } = completedRun()
    const request = claimedRequest(runId)
    const expected = draftFor()
    const changeCount = changes().length

    for (const overrides of [
      { callerKey: 'client-2' },
      { scope: { instanceId: 'other-instance' } },
      { requestId: request.id + 1000 }
    ]) {
      expect(
        finish(
          request,
          { kind: 'success', draft: expected.draft, expectedDraftHash: expected.hash },
          overrides
        )
      ).toEqual({ kind: 'refused', reason: 'not-found' })
    }
    expect(rawRequest(request.id)?.state).toBe('in_progress')
    expect(proposalRows()).toHaveLength(0)
    expect(changes()).toHaveLength(changeCount)

    // The rightful caller can still complete the request.
    expect(
      finish(request, { kind: 'success', draft: expected.draft, expectedDraftHash: expected.hash })
    ).toMatchObject({ kind: 'completed', request: { state: 'succeeded' } })
  })

  it('refuses an expected intent digest that does not match the stored claim', () => {
    const { runId } = completedRun()
    const request = claimedRequest(runId)
    const expected = draftFor()

    expect(
      finish(
        request,
        { kind: 'success', draft: expected.draft, expectedDraftHash: expected.hash },
        { expectedRequestDigest: 'b'.repeat(64) }
      )
    ).toEqual({ kind: 'refused', reason: 'request-digest-mismatch' })
    expect(rawRequest(request.id)?.state).toBe('in_progress')
    expect(proposalRows()).toHaveLength(0)

    expect(
      finish(request, { kind: 'success', draft: expected.draft, expectedDraftHash: expected.hash })
    ).toMatchObject({ kind: 'completed', request: { state: 'succeeded' } })
  })

  it('settles coded failures and unknown outcomes without a proposal, stable across reopen', () => {
    const failedRun = completedRun({ iid: 20 })
    const failedRequest = claimedRequest(failedRun.runId)
    const failed = finish(failedRequest, { kind: 'failed', reason: 'producer-failed' })
    expect(failed).toMatchObject({
      kind: 'completed',
      request: { id: failedRequest.id, state: 'failed', reasonCode: 'producer-failed' },
      proposal: null
    })

    const unknownRun = completedRun({ iid: 21 })
    const unknownRequest = claimedRequest(unknownRun.runId, 'op-2')
    const unknown = finish(unknownRequest, {
      kind: 'unverifiable',
      reason: 'unknown-outcome'
    })
    expect(unknown).toMatchObject({
      kind: 'completed',
      request: { id: unknownRequest.id, state: 'unverifiable', reasonCode: 'unknown-outcome' },
      proposal: null
    })

    expect(proposalRows()).toHaveLength(0)
    ledger.close()
    ledger = harness.open()

    // Startup only reclassifies in_progress claims; explicit terminal outcomes survive.
    expect(ledger.getPatchRequest(SCOPE, failedRequest.id, 'client-1')).toMatchObject({
      state: 'failed',
      reasonCode: 'producer-failed'
    })
    expect(ledger.getPatchRequest(SCOPE, unknownRequest.id, 'client-1')).toMatchObject({
      state: 'unverifiable',
      reasonCode: 'unknown-outcome'
    })
    expect(finish(unknownRequest, { kind: 'success', draft: draftFor().draft })).toMatchObject({
      kind: 'completed',
      request: { state: 'unverifiable', reasonCode: 'unknown-outcome' },
      proposal: null
    })
    expect(proposalRows()).toHaveLength(0)
  })

  it('rejects an unknown reason code without mutating the request', () => {
    const { runId } = completedRun()
    const request = claimedRequest(runId)

    expect(finish(request, { kind: 'failed', reason: 'raw provider error text' })).toEqual({
      kind: 'refused',
      reason: 'invalid-input'
    })
    expect(finish(request, { kind: 'unverifiable', reason: 'failed' })).toEqual({
      kind: 'refused',
      reason: 'invalid-input'
    })
    expect(finish(request, { kind: 'mystery' })).toEqual({
      kind: 'refused',
      reason: 'invalid-input'
    })
    expect(rawRequest(request.id)?.state).toBe('in_progress')
    expect(proposalRows()).toHaveLength(0)
  })

  it('settles malformed drafts, bad hashes and wrong targets as coded failures', () => {
    const { runId } = completedRun()
    const valid = draftFor()
    const wrongProject = draftFor({ projectId: '999' })
    const cases: { outcome: unknown; reason: ForgePatchRequestFailureReason }[] = [
      {
        outcome: { kind: 'success', draft: { kind: 'comment' }, expectedDraftHash: valid.hash },
        reason: 'draft-invalid'
      },
      {
        outcome: {
          kind: 'success',
          draft: { ...valid.draft, baseSha: 'not-a-sha' },
          expectedDraftHash: valid.hash
        },
        reason: 'draft-invalid'
      },
      {
        outcome: { kind: 'success', draft: valid.draft, expectedDraftHash: 'not-a-hash' },
        reason: 'draft-hash-invalid'
      },
      {
        outcome: { kind: 'success', draft: valid.draft, expectedDraftHash: 'c'.repeat(64) },
        reason: 'draft-hash-mismatch'
      },
      {
        outcome: {
          kind: 'success',
          draft: wrongProject.draft,
          expectedDraftHash: wrongProject.hash
        },
        reason: 'target-mismatch'
      }
    ]

    for (const [index, entry] of cases.entries()) {
      const request = claimedRequest(runId, `op-malformed-${index}`)
      expect(finish(request, entry.outcome)).toMatchObject({
        kind: 'completed',
        request: { state: 'failed', reasonCode: entry.reason },
        proposal: null
      })
    }
    expect(proposalRows()).toHaveLength(0)
  })

  it('refuses a non-string draft hash as invalid input', () => {
    const { runId } = completedRun()
    const request = claimedRequest(runId)
    const valid = draftFor()

    expect(finish(request, { kind: 'success', draft: valid.draft, expectedDraftHash: 42 })).toEqual(
      { kind: 'refused', reason: 'invalid-input' }
    )
    expect(rawRequest(request.id)?.state).toBe('in_progress')
    expect(proposalRows()).toHaveLength(0)
  })

  describe('completion fences', () => {
    type FenceCase = {
      name: string
      code: ForgePatchRequestFailureReason
      iid: number
      arrange: (runId: number) => void
    }

    const cases: FenceCase[] = [
      {
        name: 'run generation',
        code: 'run-mismatch',
        iid: 30,
        arrange: (runId) =>
          withDb((db) =>
            db.prepare('UPDATE runs SET generation = generation + 1 WHERE id = ?').run(runId)
          )
      },
      {
        name: 'run session',
        code: 'session-mismatch',
        iid: 31,
        arrange: (runId) =>
          withDb((db) =>
            db.prepare("UPDATE runs SET session_id = 'session-moved' WHERE id = ?").run(runId)
          )
      },
      {
        name: 'run revision',
        code: 'run-mismatch',
        iid: 32,
        arrange: (runId) =>
          withDb((db) =>
            db.prepare('UPDATE runs SET revision = revision + 1 WHERE id = ?').run(runId)
          )
      },
      {
        name: 'run policy generation',
        code: 'policy-stale',
        iid: 33,
        arrange: (runId) =>
          withDb((db) =>
            db
              .prepare('UPDATE runs SET policy_generation = policy_generation + 1 WHERE id = ?')
              .run(runId)
          )
      },
      {
        name: 'run eligibility',
        code: 'run-not-eligible',
        iid: 34,
        arrange: (runId) =>
          withDb((db) => db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(runId))
      },
      {
        name: 'item revision',
        code: 'revision-stale',
        iid: 35,
        arrange: () => {
          queueRun({ iid: 35, token: 'item-revision-moved' })
        }
      },
      {
        name: 'current project policy',
        code: 'policy-stale',
        iid: 36,
        arrange: () =>
          withDb((db) =>
            db
              .prepare(
                `INSERT INTO policies (instance_id, project_id, generation) VALUES (?, ?, 1)
                 ON CONFLICT (instance_id, project_id) DO UPDATE SET generation = generation + 1`
              )
              .run(INSTANCE_ID, PROJECT_ID)
          )
      },
      {
        name: 'project invalidation generation',
        code: 'invalidation-stale',
        iid: 37,
        arrange: () => {
          expect(
            ledger.admitWebhookDelivery({
              ...PROJECT,
              expectedConfigRevision: ledger.getConfig().configRevision,
              eventKind: 'Note Hook',
              dedupeKey: 'invalidation-moved',
              correlation: { eventUuid: null, configUuid: null },
              body: Buffer.from('{}')
            })
          ).toMatchObject({ ok: true })
        }
      },
      {
        name: 'config revision',
        code: 'config-stale',
        iid: 38,
        arrange: () => {
          expect(ledger.updateConfig(ledger.getConfig().configRevision, config())).toMatchObject({
            ok: true
          })
        }
      },
      {
        name: 'disabled project',
        code: 'project-unavailable',
        iid: 39,
        arrange: () => {
          expect(
            ledger.updateConfig(ledger.getConfig().configRevision, config({ enabled: false }))
          ).toMatchObject({ ok: true })
        }
      }
    ]

    for (const fence of cases) {
      it(`settles a moved ${fence.name} fence as ${fence.code}`, () => {
        const { runId } = completedRun({ iid: fence.iid })
        const request = claimedRequest(runId)
        const expected = draftFor()
        fence.arrange(runId)

        const result = finish(request, {
          kind: 'success',
          draft: expected.draft,
          expectedDraftHash: expected.hash
        })

        expect(result).toMatchObject({
          kind: 'completed',
          request: { id: request.id, state: 'failed', reasonCode: fence.code, proposalId: null },
          proposal: null
        })
        expect(proposalRows()).toHaveLength(0)
      })
    }
  })

  it('refuses to complete a request whose item is not a merge request', () => {
    const result = ledger.ingestEvent({
      hostId: ledger.hostId,
      ...PROJECT,
      kind: 'issue',
      iid: 90,
      dedupeKey: 'issue-run',
      eventKind: 'issue.updated',
      payload: null,
      versionToken: 'issue-head',
      title: 'An issue',
      itemState: 'opened',
      sourceOrder: ++sequence,
      queueRun: { reason: 'review-request' }
    })
    if (result.duplicate || result.runId === null) {
      throw new Error('issue run was not queued')
    }
    const runId = result.runId
    const claimed = ledger.claimNextQueuedRun(SCOPE)
    if (!claimed || claimed.id !== runId) {
      throw new Error('issue run was not claimed')
    }
    ledger.bindRunSession(runId, 'issue-session')
    ledger.transitionRun(runId, { to: 'succeeded' })
    const request = claimedRequest(runId)
    const expected = draftFor()

    expect(
      finish(request, { kind: 'success', draft: expected.draft, expectedDraftHash: expected.hash })
    ).toMatchObject({
      kind: 'completed',
      request: { state: 'failed', reasonCode: 'item-not-merge-request' },
      proposal: null
    })
    expect(proposalRows()).toHaveLength(0)
  })

  it('stales only older strict patch proposals and preserves comments, pushes and lookalikes', () => {
    const { runId, itemId } = completedRun()
    const request = claimedRequest(runId)
    const current = draftFor({ path: 'src/current.ts' })
    const older = draftFor({ path: 'src/older.ts', content: 'older\n' })
    const lookalike = draftFor({ path: 'src/lookalike.ts' })
    const comment = buildForgeCommentDraft({
      target: { instanceId: INSTANCE_ID, projectId: PROJECT_ID, kind: 'merge_request', iid: 7 },
      headSha: BASE_SHA,
      body: 'keep the review note'
    })
    if (!comment.ok) {
      throw new Error('comment fixture was rejected')
    }
    const push = {
      kind: 'push',
      target: { instanceId: INSTANCE_ID, projectId: PROJECT_ID },
      branch: 'feature/work',
      expectedHeadSha: BASE_SHA,
      treeSha: 'b'.repeat(40),
      commitSha: 'c'.repeat(40),
      commit: {
        author: { name: 'A', email: 'a@example.com', timeSeconds: 1, timezone: '+00:00' },
        committer: { name: 'A', email: 'a@example.com', timeSeconds: 1, timezone: '+00:00' },
        message: 'keep the push plan'
      }
    }
    const spoof = { kind: 'patch' }
    const extraField = { ...lookalike.draft, unexpected: true }

    const insert = (body: unknown) =>
      withDb((db) => {
        const inserted = db
          .prepare(
            `INSERT INTO proposals (run_id, item_id, revision, policy_generation, status,
               body_json, created_at, resolved_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL)`
          )
          .run(runId, itemId, request.revision, request.policyGeneration, JSON.stringify(body), 1)
        return Number(inserted.lastInsertRowid)
      })

    const ids = {
      older: insert(older.draft),
      lookalike: insert(lookalike.draft),
      comment: insert(comment.draft),
      push: insert(push),
      spoof: insert(spoof),
      extraField: insert(extraField)
    }

    const result = finish(request, {
      kind: 'success',
      draft: current.draft,
      expectedDraftHash: current.hash
    })
    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed' || !result.proposal) {
      throw new Error('finish was refused')
    }

    expect(ledger.getProposal(ids.older)?.status).toBe('stale')
    expect(ledger.getProposal(ids.older)?.resolvedAt).not.toBeNull()
    // Another strict patch is intentionally replaced too.
    expect(ledger.getProposal(ids.lookalike)?.status).toBe('stale')
    for (const preserved of [ids.comment, ids.push, ids.spoof, ids.extraField]) {
      expect(ledger.getProposal(preserved)?.status).toBe('pending')
      expect(ledger.getProposal(preserved)?.resolvedAt).toBeNull()
    }
    expect(ledger.getProposal(ids.comment)?.body).toEqual(comment.draft)
    expect(ledger.getProposal(ids.push)?.body).toEqual(push)
    expect(ledger.getProposal(result.proposal.id)?.status).toBe('pending')

    const staleChanges = changes().filter(
      (change) => change.entity === 'proposal' && change.change === 'stale'
    )
    expect(staleChanges.map((change) => change.entityId)).toEqual([ids.older, ids.lookalike])
    // A strict patch with an extra field is not the patch kind we supersede.
    expect(ledger.getProposal(ids.extraField)?.body).toEqual(extraField)
  })

  it('rolls back the proposal, change and request update when the transaction fails', () => {
    const { runId } = completedRun()
    const request = claimedRequest(runId)
    const expected = draftFor()
    const changeCount = changes().length

    withDb((db) =>
      db.exec(`
        CREATE TRIGGER patch_request_completion_fault
        BEFORE UPDATE ON patch_requests
        WHEN NEW.state = 'succeeded'
        BEGIN SELECT RAISE(ABORT, 'completion fault'); END;
      `)
    )
    try {
      expect(() =>
        finish(request, {
          kind: 'success',
          draft: expected.draft,
          expectedDraftHash: expected.hash
        })
      ).toThrow()
    } finally {
      withDb((db) => db.exec('DROP TRIGGER patch_request_completion_fault'))
    }

    expect(rawRequest(request.id)?.state).toBe('in_progress')
    expect(proposalRows()).toHaveLength(0)
    expect(changes()).toHaveLength(changeCount)

    // The claim remains completable once the failure is gone.
    expect(
      finish(request, { kind: 'success', draft: expected.draft, expectedDraftHash: expected.hash })
    ).toMatchObject({ kind: 'completed', request: { state: 'succeeded' } })
    expect(proposalRows()).toHaveLength(1)
    expect(requestRows()).toHaveLength(1)
  })

  it('never persists the draft body or transient intent text in the request row or change feed', () => {
    const { runId } = completedRun()
    const request = claimedRequest(runId)
    const marker = 'sensitive-content-marker-71f0'
    const expected = draftFor({ content: `export const secret = '${marker}'\n` })

    const result = finish(request, {
      kind: 'success',
      draft: expected.draft,
      expectedDraftHash: expected.hash
    })
    expect(result.kind).toBe('completed')

    const row = rawRequest(request.id)
    const requestValues = Object.values(row ?? {}).filter(
      (value): value is string => typeof value === 'string'
    )
    expect(requestValues.some((value) => value.includes(marker))).toBe(false)
    expect(requestValues.some((value) => value.includes(INTENT.message))).toBe(false)
    const changeValues = changes().flatMap((change) =>
      Object.values(change).filter((value): value is string => typeof value === 'string')
    )
    expect(changeValues.some((value) => value.includes(marker))).toBe(false)
  })

  it('is exported as a ledger method with the same result', () => {
    expect(typeof finishForgePatchRequest).toBe('function')
    const { runId } = completedRun()
    const request = claimedRequest(runId)
    const expected = draftFor()
    expect(
      ledger.finishPatchRequest({
        scope: SCOPE,
        callerKey: 'client-1',
        requestId: request.id,
        expectedRequestDigest: request.requestDigest,
        outcome: {
          kind: 'success',
          draft: expected.draft,
          expectedDraftHash: expected.hash
        }
      })
    ).toMatchObject({ kind: 'completed', request: { state: 'succeeded' } })
  })
})

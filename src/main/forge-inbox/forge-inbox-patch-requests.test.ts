import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  FORGE_PATCH_REQUEST_MAX_IDENTIFIER_CHARS,
  FORGE_PATCH_REQUEST_MAX_MESSAGE_CHARS,
  FORGE_PATCH_REQUEST_MAX_PATH_CHARS,
  FORGE_PATCH_REQUEST_MAX_PATHS,
  type ForgePatchRequestClaimInput
} from './forge-inbox-patch-requests'
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
const INTENT = { message: 'please fix the flaky test', paths: ['src/b.ts', 'src/a.ts'] }

function config(projectOverrides: Record<string, unknown> = {}, projects?: unknown[]) {
  return webhookConfig([
    webhookInstance({
      projects: projects ?? [
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

describe('forge inbox explicit patch requests', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let sequence: number

  const claim = (runId: number, overrides: Partial<ForgePatchRequestClaimInput> = {}) =>
    ledger.claimPatchRequest({
      scope: SCOPE,
      callerKey: 'client-1',
      operationId: 'op-1',
      runId,
      intent: INTENT,
      ...overrides
    })

  const requestRows = () => {
    const db = new Database(harness.dbPath)
    try {
      return db.prepare('SELECT * FROM patch_requests ORDER BY id').all()
    } finally {
      db.close()
    }
  }

  const rawRequest = (id: number) => {
    const db = new Database(harness.dbPath)
    try {
      return db.prepare('SELECT * FROM patch_requests WHERE id = ?').get(id)
    } finally {
      db.close()
    }
  }

  const settleRequest = (id: number, updatedAt: number) => {
    const db = new Database(harness.dbPath)
    try {
      db.prepare("UPDATE patch_requests SET state = 'succeeded', updated_at = ? WHERE id = ?").run(
        updatedAt,
        id
      )
    } finally {
      db.close()
    }
  }

  const setRequestState = (id: number, state: 'succeeded' | 'unverifiable', updatedAt: number) => {
    const db = new Database(harness.dbPath)
    try {
      db.prepare('UPDATE patch_requests SET state = ?, updated_at = ? WHERE id = ?').run(
        state,
        updatedAt,
        id
      )
    } finally {
      db.close()
    }
  }

  function queueRun(
    options: {
      projectId?: string
      iid?: number
      token?: string
      instanceId?: string
    } = {}
  ) {
    const order = ++sequence
    const token = options.token ?? `head-${order}`
    const result = ledger.ingestEvent({
      hostId: ledger.hostId,
      instanceId: options.instanceId ?? INSTANCE_ID,
      projectId: options.projectId ?? PROJECT_ID,
      kind: 'merge_request',
      iid: options.iid ?? 7,
      dedupeKey: `delivery-${order}`,
      eventKind: 'merge_request.updated',
      payload: null,
      versionToken: token,
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

  /** A run that finished an analysis and persisted the very session a patch request continues. */
  function completedRun(
    options: {
      state?: 'succeeded' | 'awaiting-approval'
      sessionId?: string | null
      bindSession?: boolean
      projectId?: string
      iid?: number
      token?: string
    } = {}
  ) {
    const { runId, itemId } = queueRun(options)
    const claimed = ledger.claimNextQueuedRun(SCOPE)
    if (!claimed || claimed.id !== runId) {
      throw new Error('queued run was not claimed')
    }
    if (options.bindSession !== false) {
      const bound = ledger.bindRunSession(runId, options.sessionId ?? 'session-1')
      if (!bound) {
        throw new Error('session was not bound')
      }
    }
    const transitioned = ledger.transitionRun(runId, { to: options.state ?? 'succeeded' })
    if (!transitioned.ok) {
      throw new Error(`run did not settle: ${transitioned.reason}`)
    }
    return { runId, itemId }
  }

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger, config())
    sequence = 0
  })
  afterEach(() => harness.dispose())

  it('claims once, replays the identical intent, and reads only for the claiming caller', () => {
    const { runId } = completedRun()

    const first = claim(runId)
    expect(first).toMatchObject({
      kind: 'claimed',
      request: {
        state: 'in_progress',
        runId,
        sessionId: 'session-1',
        revision: 1,
        policyGeneration: ledger.getRun(runId)?.policyGeneration,
        runGeneration: 2,
        configRevision: ledger.getConfig().configRevision,
        invalidationGeneration: 0,
        proposalId: null,
        reasonCode: null
      }
    })
    if (first.kind !== 'claimed') {
      throw new Error('claim was refused')
    }

    const replay = claim(runId)
    expect(replay).toMatchObject({ kind: 'in-progress', request: { id: first.request.id } })
    expect(requestRows()).toHaveLength(1)

    expect(ledger.getPatchRequest(SCOPE, first.request.id, 'client-1')).toMatchObject({
      id: first.request.id,
      state: 'in_progress'
    })
    // Another trusted caller is never handed this caller's request.
    expect(ledger.getPatchRequest(SCOPE, first.request.id, 'client-2')).toBeNull()
    expect(ledger.getPatchRequest({ instanceId: 'other' }, first.request.id, 'client-1')).toBeNull()
  })

  it('verifies the stored item scope before replaying any outcome', () => {
    const { runId } = completedRun()
    const first = claim(runId)
    if (first.kind !== 'claimed') {
      throw new Error('claim was refused')
    }
    const fences = {
      id: first.request.id,
      callerKey: 'client-1',
      operationId: 'op-1',
      requestDigest: first.request.requestDigest,
      runId,
      itemId: first.request.itemId,
      sessionId: 'session-1',
      runGeneration: first.request.runGeneration,
      revision: first.request.revision,
      policyGeneration: first.request.policyGeneration,
      configRevision: first.request.configRevision,
      invalidationGeneration: first.request.invalidationGeneration,
      proposalId: null,
      reasonCode: null
    }
    const wrongScope = { instanceId: 'other' }

    // Same instance and host-wide scope replay the stored answer and its captured fences.
    expect(claim(runId)).toMatchObject({ kind: 'in-progress', request: fences })
    expect(claim(runId, { scope: {} })).toMatchObject({ kind: 'in-progress', request: fences })
    // Another explicit instance is told nothing about the stored request and cannot copy it.
    expect(claim(runId, { scope: wrongScope })).toEqual({
      kind: 'refused',
      reason: 'run-not-found'
    })
    expect(requestRows()).toHaveLength(1)

    // Eligibility moving under the claim never re-prices a correct-scope replay.
    expect(
      ledger.updateProjectPolicy(ledger.getConfig().configRevision, {
        ...PROJECT,
        patch: { rules: 'stricter rules' }
      })
    ).toMatchObject({ ok: true })
    expect(claim(runId)).toMatchObject({ kind: 'in-progress', request: fences })

    // Terminal and unverifiable answers are fenced to the stored item's scope as well.
    setRequestState(first.request.id, 'succeeded', 2_000)
    expect(claim(runId)).toMatchObject({ kind: 'terminal', request: fences })
    expect(claim(runId, { scope: wrongScope })).toEqual({
      kind: 'refused',
      reason: 'run-not-found'
    })
    setRequestState(first.request.id, 'unverifiable', 3_000)
    expect(claim(runId)).toMatchObject({ kind: 'unverifiable', request: fences })
    expect(claim(runId, { scope: wrongScope })).toEqual({
      kind: 'refused',
      reason: 'run-not-found'
    })
    expect(requestRows()).toHaveLength(1)
  })

  it('refuses a stored request whose item belongs to another host', () => {
    const { runId } = completedRun()
    const first = claim(runId)
    if (first.kind !== 'claimed') {
      throw new Error('claim was refused')
    }
    const db = new Database(harness.dbPath)
    try {
      db.prepare("UPDATE items SET host_id = 'another-host' WHERE id = ?").run(first.request.itemId)
    } finally {
      db.close()
    }
    expect(claim(runId)).toEqual({ kind: 'refused', reason: 'run-not-found' })
    expect(requestRows()).toHaveLength(1)
  })

  it('refuses the same operation id when the canonical intent changes', () => {
    const { runId } = completedRun()
    const first = claim(runId)
    expect(first.kind).toBe('claimed')

    expect(claim(runId, { intent: { ...INTENT, message: 'something else' } })).toMatchObject({
      kind: 'refused',
      reason: 'intent-conflict'
    })
    expect(claim(runId, { intent: { ...INTENT, paths: ['src/a.ts'] } })).toMatchObject({
      kind: 'refused',
      reason: 'intent-conflict'
    })
    expect(requestRows()).toHaveLength(1)
  })

  it('treats path order and repeated paths as the same canonical intent', () => {
    const { runId } = completedRun()
    const first = claim(runId, {
      intent: { message: INTENT.message, paths: ['src/b.ts', 'src/a.ts'] }
    })
    if (first.kind !== 'claimed') {
      throw new Error('claim was refused')
    }

    // A set of paths is unordered and duplicate-free, so a retry in another order is the same claim.
    expect(
      claim(runId, {
        intent: { message: INTENT.message, paths: ['src/a.ts', 'src/b.ts', 'src/a.ts'] }
      })
    ).toMatchObject({ kind: 'in-progress', request: { id: first.request.id } })
    // A different set is a different intent, even under the same operation key.
    expect(
      claim(runId, { intent: { message: INTENT.message, paths: ['src/a.ts'] } })
    ).toMatchObject({ kind: 'refused', reason: 'intent-conflict' })
    expect(requestRows()).toHaveLength(1)
  })

  it('isolates the same operation id between callers', () => {
    const { runId } = completedRun()
    const first = claim(runId)
    const second = claim(runId, { callerKey: 'client-2' })
    expect(first.kind).toBe('claimed')
    expect(second.kind).toBe('claimed')
    if (first.kind !== 'claimed' || second.kind !== 'claimed') {
      throw new Error('claims were refused')
    }
    expect(second.request.id).not.toBe(first.request.id)
    expect(requestRows()).toHaveLength(2)
    expect(ledger.getPatchRequest(SCOPE, first.request.id, 'client-2')).toBeNull()
    expect(ledger.getPatchRequest(SCOPE, second.request.id, 'client-1')).toBeNull()
  })

  it('rejects malformed caller keys and operation ids before writing', () => {
    const { runId } = completedRun()
    const changesBefore = ledger.listChanges(SCOPE, { afterSeq: 0 }).changes.length
    for (const callerKey of [
      '',
      'x'.repeat(FORGE_PATCH_REQUEST_MAX_IDENTIFIER_CHARS + 1),
      'bad\u0000key',
      'bad\nkey'
    ]) {
      expect(claim(runId, { callerKey })).toMatchObject({
        kind: 'refused',
        reason: 'invalid-caller'
      })
    }
    for (const operationId of [
      '',
      'x'.repeat(FORGE_PATCH_REQUEST_MAX_IDENTIFIER_CHARS + 1),
      'bad\noperation'
    ]) {
      expect(claim(runId, { operationId })).toMatchObject({
        kind: 'refused',
        reason: 'invalid-operation-id'
      })
    }
    expect(requestRows()).toHaveLength(0)
    expect(ledger.listChanges(SCOPE, { afterSeq: 0 }).changes).toHaveLength(changesBefore)
  })

  it('rejects an empty, oversized or malformed intent before writing', () => {
    const { runId } = completedRun()
    const invalid = [
      { ...INTENT, message: '' },
      { ...INTENT, message: '   ' },
      { ...INTENT, message: 'x'.repeat(FORGE_PATCH_REQUEST_MAX_MESSAGE_CHARS + 1) },
      { ...INTENT, paths: ['x'.repeat(FORGE_PATCH_REQUEST_MAX_PATH_CHARS + 1)] },
      {
        ...INTENT,
        paths: Array.from({ length: FORGE_PATCH_REQUEST_MAX_PATHS + 1 }, (_, index) => `p${index}`)
      },
      { ...INTENT, paths: ['ok', ''] },
      { ...INTENT, paths: ['bad\u0000path'] }
    ]
    for (const intent of invalid) {
      expect(claim(runId, { intent })).toMatchObject({ kind: 'refused', reason: 'invalid-intent' })
    }
    expect(requestRows()).toHaveLength(0)
  })

  it('captures config, invalidation, policy and run fences at claim time', () => {
    const admitted = ledger.admitWebhookDelivery({
      ...PROJECT,
      expectedConfigRevision: ledger.getConfig().configRevision,
      eventKind: 'Note Hook',
      dedupeKey: 'invalidate-before-claim',
      correlation: { eventUuid: null, configUuid: null },
      body: Buffer.from('{}')
    })
    expect(admitted).toMatchObject({ ok: true })
    const { runId } = completedRun()
    expect(ledger.readProjectInvalidationGeneration(PROJECT)).toBe(1)

    const capturedConfig = ledger.getConfig().configRevision
    const capturedPolicy = ledger.getRun(runId)?.policyGeneration
    const first = claim(runId)
    expect(first).toMatchObject({
      kind: 'claimed',
      request: {
        configRevision: capturedConfig,
        invalidationGeneration: 1,
        policyGeneration: capturedPolicy,
        runGeneration: 2,
        revision: 1
      }
    })

    // The captured fences stay put even when every live fence moves; a replay never re-prices.
    const policy = ledger.updateProjectPolicy(ledger.getConfig().configRevision, {
      ...PROJECT,
      patch: { rules: 'stricter rules' }
    })
    expect(policy).toMatchObject({ ok: true })
    const again = ledger.admitWebhookDelivery({
      ...PROJECT,
      expectedConfigRevision: ledger.getConfig().configRevision,
      eventKind: 'Note Hook',
      dedupeKey: 'invalidate-after-claim',
      correlation: { eventUuid: null, configUuid: null },
      body: Buffer.from('{}')
    })
    expect(again).toMatchObject({ ok: true })

    expect(claim(runId)).toMatchObject({
      kind: 'in-progress',
      request: {
        configRevision: capturedConfig,
        invalidationGeneration: 1,
        policyGeneration: capturedPolicy,
        runGeneration: 2
      }
    })
  })

  it('refuses runs that never settled or never persisted their session', () => {
    const queued = queueRun()
    expect(claim(queued.runId)).toMatchObject({ kind: 'refused', reason: 'run-not-eligible' })

    const running = ledger.claimNextQueuedRun(SCOPE)
    if (!running) {
      throw new Error('no run claimed')
    }
    expect(claim(running.id)).toMatchObject({ kind: 'refused', reason: 'run-not-eligible' })

    const unbound = completedRun({ bindSession: false })
    expect(claim(unbound.runId)).toMatchObject({ kind: 'refused', reason: 'session-not-bound' })
    expect(requestRows()).toHaveLength(0)
  })

  it('refuses a run whose head revision or original policy generation moved', () => {
    const revision = completedRun({ token: 'head-a' })
    const moved = queueRun({ token: 'head-b' })
    expect(claim(revision.runId)).toMatchObject({ kind: 'refused', reason: 'revision-stale' })
    ledger.transitionRun(moved.runId, { to: 'cancelled' })

    const policy = completedRun({ token: 'head-c', iid: 8 })
    expect(
      ledger.updateProjectPolicy(ledger.getConfig().configRevision, {
        ...PROJECT,
        patch: { rules: 'stricter rules' }
      })
    ).toMatchObject({ ok: true })
    expect(claim(policy.runId)).toMatchObject({ kind: 'refused', reason: 'policy-stale' })
    expect(requestRows()).toHaveLength(0)
  })

  it('refuses runs outside the owner, instance scope, or enabled project policy', () => {
    const { runId } = completedRun()
    expect(claim(runId, { scope: { instanceId: 'other' } })).toMatchObject({
      kind: 'refused',
      reason: 'run-not-found'
    })
    expect(claim(runId + 1000)).toMatchObject({ kind: 'refused', reason: 'run-not-found' })

    const db = new Database(harness.dbPath)
    try {
      db.exec(`
        INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title, state,
          current_revision, head_order, activity_seq, created_at, updated_at)
          VALUES (99, 'another-host', '${INSTANCE_ID}', '${PROJECT_ID}', 'merge_request', 99,
            'Foreign', 'opened', 1, 1, 1, 1, 1);
        INSERT INTO runs (id, item_id, revision, state, generation, policy_generation,
          context_digest, analysis_kind, reason, session_id, created_at, updated_at)
          VALUES (99, 99, 1, 'succeeded', 2, 1, 'd', 'merge_request', 'r', 'session-x', 1, 1);
      `)
    } finally {
      db.close()
    }
    expect(claim(99)).toMatchObject({ kind: 'refused', reason: 'run-not-found' })

    // Project 43 is a real item but has no enabled policy in this host's config.
    const unconfigured = completedRun({ projectId: '43', iid: 43 })
    expect(claim(unconfigured.runId)).toMatchObject({
      kind: 'refused',
      reason: 'project-unavailable'
    })

    const disabledLedger = harness.open()
    disabledLedger.updateConfig(
      disabledLedger.getConfig().configRevision,
      config({ enabled: false })
    )
    const disabled = (() => {
      const queued = disabledLedger.ingestEvent({
        hostId: disabledLedger.hostId,
        ...PROJECT,
        kind: 'merge_request',
        iid: 50,
        dedupeKey: 'disabled-run',
        eventKind: 'merge_request.updated',
        payload: null,
        versionToken: 'disabled-head',
        sourceOrder: 1,
        queueRun: { reason: 'review-request' }
      })
      if (queued.duplicate || queued.runId === null) {
        throw new Error('no disabled run queued')
      }
      return queued.runId
    })()
    const claimed = disabledLedger.claimNextQueuedRun(SCOPE)
    if (!claimed || claimed.id !== disabled) {
      throw new Error('disabled run was not claimed')
    }
    disabledLedger.bindRunSession(disabled, 'session-disabled')
    disabledLedger.transitionRun(disabled, { to: 'succeeded' })
    expect(
      disabledLedger.claimPatchRequest({
        scope: SCOPE,
        callerKey: 'client-1',
        operationId: 'op-1',
        runId: disabled,
        intent: INTENT
      })
    ).toMatchObject({ kind: 'refused', reason: 'project-unavailable' })
    expect(requestRows()).toHaveLength(0)
  })

  it('stores only the canonical digest, never the transient message or paths', () => {
    const { runId } = completedRun()
    const message = 'please change the sensitive implementation detail'
    const paths = ['src/private/secret-widget.ts']
    const first = claim(runId, { intent: { message, paths } })
    if (first.kind !== 'claimed') {
      throw new Error('claim was refused')
    }
    const row = rawRequest(first.request.id)
    expect(row).toBeDefined()
    const values = Object.values(row ?? {}).filter(
      (value): value is string => typeof value === 'string'
    )
    expect(values).not.toContain(message)
    expect(values).not.toContain(paths[0])
    expect(values.some((value) => value.includes('sensitive implementation'))).toBe(false)
    expect(String(row?.request_digest)).toMatch(/^[0-9a-f]{64}$/)

    const db = new Database(harness.dbPath)
    try {
      const columns = db
        .prepare("SELECT name FROM pragma_table_info('patch_requests')")
        .all()
        .map((entry) => String(entry.name))
        .join(',')
      for (const fragment of ['message', 'prompt', 'body', 'path', 'secret', 'source']) {
        expect(columns).not.toContain(fragment)
      }
    } finally {
      db.close()
    }
  })

  it('marks only interrupted claims unverifiable on owner open and never re-runs one', () => {
    const { runId } = completedRun()
    const first = claim(runId)
    const terminal = claim(runId, { callerKey: 'client-2', operationId: 'op-2' })
    if (first.kind !== 'claimed' || terminal.kind !== 'claimed') {
      throw new Error('claims were refused')
    }
    settleRequest(terminal.request.id, 9999)
    const runsBefore = ledger.listRuns(SCOPE, {}).rows.length

    ledger.close()
    ledger = harness.open()

    expect(ledger.getPatchRequest(SCOPE, first.request.id, 'client-1')).toMatchObject({
      id: first.request.id,
      state: 'unverifiable',
      reasonCode: 'interrupted'
    })
    expect(ledger.getPatchRequest(SCOPE, terminal.request.id, 'client-2')).toMatchObject({
      id: terminal.request.id,
      state: 'succeeded',
      updatedAt: 9999
    })
    expect(claim(runId)).toMatchObject({
      kind: 'unverifiable',
      request: { id: first.request.id, state: 'unverifiable' }
    })
    expect(
      ledger.claimPatchRequest({
        scope: SCOPE,
        callerKey: 'client-2',
        operationId: 'op-2',
        runId,
        intent: INTENT
      })
    ).toMatchObject({ kind: 'terminal', request: { id: terminal.request.id, state: 'succeeded' } })
    expect(requestRows()).toHaveLength(2)
    expect(ledger.listRuns(SCOPE, {}).rows.length).toBe(runsBefore)
  })

  it('leaves the change feed and request table untouched when a claim is refused', () => {
    const { runId } = completedRun()
    expect(
      ledger.updateProjectPolicy(ledger.getConfig().configRevision, {
        ...PROJECT,
        patch: { rules: 'stricter rules' }
      })
    ).toMatchObject({ ok: true })
    const changesBefore = ledger.listChanges(SCOPE, { afterSeq: 0 }).changes.length

    expect(claim(runId)).toMatchObject({ kind: 'refused', reason: 'policy-stale' })
    expect(ledger.listChanges(SCOPE, { afterSeq: 0 }).changes).toHaveLength(changesBefore)
    expect(requestRows()).toHaveLength(0)
  })
})

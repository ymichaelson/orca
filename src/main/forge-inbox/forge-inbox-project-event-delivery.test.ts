import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecretStore } from '../../shared/secret-store'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import {
  admitProjectEventDelivery,
  resumeParkedProjectEventDeliveries
} from './forge-inbox-project-event-delivery'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { resumeProjectEventDeliveriesForRepo } from './forge-inbox-project-event-receive'
import { claimNextForgeWebhookDelivery } from './forge-inbox-webhook-delivery-state'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

const REPO_ID = 'repo-1'
const PROJECT_PATH = 'group/demo'
const BODY = Buffer.from('{"object_kind":"merge_request"}')

describe('project event delivery admission', () => {
  let root: string
  let store: SecretStore
  let ctx: ForgeLedgerContext
  let bindingId: string

  const admission = (
    overrides: Partial<Parameters<typeof admitProjectEventDelivery>[2]> = {}
  ): Parameters<typeof admitProjectEventDelivery>[2] => ({
    bindingId,
    projectPath: PROJECT_PATH,
    policyGeneration: 1,
    policyEnabled: true,
    eventKind: 'merge_request',
    dedupeKey: 'delivery-1',
    correlation: { eventUuid: 'event-uuid-1', configUuid: 'hook-uuid-1' },
    body: BODY,
    ...overrides
  })

  const admit = (
    overrides: Partial<Parameters<typeof admitProjectEventDelivery>[2]> = {}
  ): ReturnType<typeof admitProjectEventDelivery> =>
    admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, admission(overrides))

  const linkRepo = (): void => {
    ctx.db
      .prepare(
        `INSERT INTO project_event_repo_links (host_id, repo_id, binding_id, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(ctx.hostId, REPO_ID, bindingId, 10)
  }

  const row = (id: number) =>
    ctx.db
      .prepare(
        `SELECT instance_id, binding_id, project_id, policy_generation, state, parked_reason,
           length(body) AS bytes
         FROM webhook_deliveries WHERE id = ?`
      )
      .get(id)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-project-delivery-'))
    let clock = 1000
    const opened = openForgeInboxDatabase(join(root, 'forge-inbox.sqlite'), 'host-1')
    store = fakeStore()
    ctx = { db: opened.db, hostId: opened.hostId, now: () => ++clock, secretStore: () => store }
    bindingId = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: '/repo',
      gitlabHost: 'gitlab.test',
      gitlabPath: PROJECT_PATH,
      gitlabProjectId: 3,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
    })
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('admits an enabled project event as a pending delivery owned by its binding', () => {
    const result = admit()

    expect(result).toMatchObject({ ok: true, duplicate: false, state: 'pending' })
    if (!result.ok) {
      throw new Error('expected admission')
    }
    expect(row(result.deliveryId)).toEqual({
      instance_id: null,
      binding_id: bindingId,
      project_id: PROJECT_PATH,
      policy_generation: 1,
      state: 'pending',
      parked_reason: null,
      bytes: BODY.length
    })
  })

  it('treats a replayed delivery of the same binding as a duplicate', () => {
    const first = admit()
    const second = admit()

    expect(first.ok && first.deliveryId).toBeTruthy()
    expect(second).toMatchObject({ ok: true, duplicate: true })
    if (!first.ok || !second.ok) {
      throw new Error('expected two admissions')
    }
    expect(second.deliveryId).toBe(first.deliveryId)
  })

  it('deduplicates per binding, so another binding with the same key is a separate delivery', () => {
    const other = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId: other,
      projectPath: '/other',
      gitlabHost: 'gitlab.test',
      gitlabPath: 'group/other',
      gitlabProjectId: 4,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${other}`
    })

    const first = admit()
    const second = admit({ bindingId: other })

    expect(second).toMatchObject({ ok: true, duplicate: false })
    if (!first.ok || !second.ok) {
      throw new Error('expected two admissions')
    }
    expect(second.deliveryId).not.toBe(first.deliveryId)
  })

  it('parks an event whose binding has no project policy yet and keeps its body', () => {
    const result = admit({ policyGeneration: null, policyEnabled: false })

    expect(result).toMatchObject({ ok: true, state: 'parked' })
    if (!result.ok) {
      throw new Error('expected admission')
    }
    expect(row(result.deliveryId)).toMatchObject({
      state: 'parked',
      parked_reason: 'awaiting-policy',
      policy_generation: null,
      bytes: BODY.length
    })
    // The retired instance worker must never consume a binding delivery.
    expect(claimNextForgeWebhookDelivery(ctx, 10_000)).toBeNull()
  })

  it('finishes a delivery for a disabled policy without keeping its body', () => {
    const result = admit({ policyGeneration: 2, policyEnabled: false })

    expect(result).toMatchObject({ ok: true, state: 'done' })
    if (!result.ok) {
      throw new Error('expected admission')
    }
    expect(row(result.deliveryId)).toMatchObject({ state: 'done', bytes: 0 })
    expect(claimNextForgeWebhookDelivery(ctx, 10_000)).toBeNull()
  })

  it('resumes the parked deliveries of a binding once its policy exists', () => {
    const parked = admit({ policyGeneration: null, policyEnabled: false })
    if (!parked.ok) {
      throw new Error('expected admission')
    }

    const resumed = resumeParkedProjectEventDeliveries(ctx, { bindingId, policyGeneration: 4 })

    expect(resumed).toBe(1)
    expect(row(parked.deliveryId)).toMatchObject({
      state: 'pending',
      parked_reason: null,
      policy_generation: 4
    })
  })

  it('refuses a body over the limit and writes nothing', () => {
    const result = admit({ body: Buffer.alloc(1024 * 1024 + 1) })

    expect(result).toEqual({ ok: false, reason: 'body-too-large' })
    expect(Number(ctx.db.prepare('SELECT count(*) AS c FROM webhook_deliveries').get()?.c)).toBe(0)
  })

  it('refuses an enabled delivery when the pending queue is at its bound', () => {
    const limits = { maxPending: 1, maxQueuedBytes: 16 * 1024 * 1024 }
    expect(admitProjectEventDelivery(ctx, limits, admission({ dedupeKey: 'delivery-1' })).ok).toBe(
      true
    )

    expect(admitProjectEventDelivery(ctx, limits, admission({ dedupeKey: 'delivery-2' }))).toEqual({
      ok: false,
      reason: 'queue-full'
    })
  })

  it('counts a parked body against the queue byte bound', () => {
    const limits = { maxPending: 1000, maxQueuedBytes: 40 }
    expect(admitProjectEventDelivery(ctx, limits, admission({ policyGeneration: null })).ok).toBe(
      true
    )

    expect(admitProjectEventDelivery(ctx, limits, admission({ dedupeKey: 'delivery-2' }))).toEqual({
      ok: false,
      reason: 'queue-full'
    })
  })

  it('leaves parked deliveries alone while the repository policy stays disabled', () => {
    const parked = admit({ policyGeneration: null, policyEnabled: false })
    if (!parked.ok) {
      throw new Error('expected admission')
    }
    linkRepo()
    updateProjectEventPolicy(ctx, { repoId: REPO_ID, expectedGeneration: 0, patch: {} })

    expect(resumeProjectEventDeliveriesForRepo(ctx, REPO_ID)).toBe(0)
    expect(row(parked.deliveryId)).toMatchObject({ state: 'parked' })
  })

  it('resumes parked deliveries when the policy is enabled through the ledger', () => {
    const parked = admit({ policyGeneration: null, policyEnabled: false })
    if (!parked.ok) {
      throw new Error('expected admission')
    }
    linkRepo()

    const ledger = ForgeInboxLedger.open(join(root, 'forge-inbox.sqlite'), { hostId: 'host-1' })
    try {
      expect(ledger.updateProjectEventPolicy(REPO_ID, 0, { enabled: true })).toMatchObject({
        ok: true,
        generation: 1
      })
    } finally {
      ledger.close()
    }

    expect(row(parked.deliveryId)).toMatchObject({ state: 'pending', policy_generation: 1 })
    expect(claimNextForgeWebhookDelivery(ctx, 10_000)).toBeNull()
  })
})

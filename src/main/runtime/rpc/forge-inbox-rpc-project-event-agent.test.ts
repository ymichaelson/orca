import { afterEach, describe, expect, it } from 'vitest'
import { readProjectBindingSecret } from '../../forge-inbox/forge-inbox-project-binding-secret'
import {
  ensureOwnerFixtureBinding,
  PROJECT_EVENT_BINDING_ID
} from '../../forge-inbox/forge-inbox-owner-fixture-binding'
import { fakeGitlab } from '../../forge-inbox/forge-inbox-project-binding-test-fixture'
import type { ForgeInboxLedger } from '../../forge-inbox/forge-inbox-ledger'
import { createReceiverSettingsFixture } from '../../project-events/project-event-receiver-settings-test-fixture'
import {
  configure,
  createForgeRpcHarness,
  recordOf,
  recordsOf,
  type ForgeRpcHarness
} from './forge-inbox-rpc-test-kit'
import { WEBHOOK_TOKEN as FIXTURE_TOKEN } from '../../forge-inbox/forge-inbox-webhook-test-harness'

const FORBIDDEN_KEYS = ['secret', 'pendingSecret', 'secret_envelope', 'body', 'payload', 'prompt']

function collectKeys(value: unknown, keys: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeys(entry, keys))
    return
  }
  if (typeof value !== 'object' || value === null) {
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    keys.push(key)
    collectKeys(entry, keys)
  }
}

function seedPendingDeliveries(ledger: ForgeInboxLedger, count: number): void {
  const db = ledger.ledgerContext().db
  const insert = db.prepare(
    `INSERT INTO webhook_deliveries (host_id, binding_id, project_id, dedupe_key, event_kind,
       admitted_at, state, attempts, body, decision_state)
     VALUES (?, ?, '42', ?, 'Issue Hook', ?, 'pending', 0, ?, 'queued')`
  )
  for (let index = 1; index <= count; index++) {
    insert.run(
      ledger.hostId,
      PROJECT_EVENT_BINDING_ID,
      `activity-${index}`,
      index,
      Buffer.from(
        JSON.stringify({
          object_kind: 'issue',
          object_attributes: { iid: index, title: `Event ${index}` }
        })
      )
    )
  }
}

describe('forge inbox project event agent rpc', () => {
  let harness: ForgeRpcHarness | undefined

  afterEach(async () => {
    await harness?.close()
    harness = undefined
  })

  it('returns five recent events and then an empty view once the owner stops', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    ensureOwnerFixtureBinding(harness.dbPath, harness.secretStore)
    const ledger = harness.openLedger(ownerHostId)
    seedPendingDeliveries(ledger, 6)

    const view = await harness.ok('forgeInbox.getProjectEventActivity', {
      ownerHostId,
      repoId: 'repo-1'
    })

    expect(view).toMatchObject({ ownerHostId, repoId: 'repo-1' })
    const events = recordsOf(view.events)
    expect(events).toHaveLength(5)
    expect(events[0]).toMatchObject({
      kind: 'issue',
      iid: 6,
      title: 'Event 6',
      occurredAt: 6,
      outcome: 'processing'
    })
    const keys: string[] = []
    collectKeys(view, keys)
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys).not.toContain(forbidden)
    }

    await harness.stop()
    const stopped = await harness.ok('forgeInbox.getProjectEventActivity', {
      ownerHostId,
      repoId: 'repo-1'
    })
    expect(stopped).toMatchObject({ events: [], lastProcessed: null })
  })

  it('rotates through the trusted repository context without exposing either secret', async () => {
    const gitlab = fakeGitlab({ projectId: 42 })
    harness = await createForgeRpcHarness({
      receiverSettings: createReceiverSettingsFixture(),
      ownerOptions: {
        resolveProjectBindingContext: () => ({
          ok: true,
          repoPath: '/trusted/repo',
          connectionId: null,
          source: 'repo',
          explicitProjectRefText: null
        }),
        projectBindingExec: gitlab.exec
      }
    })
    const ownerHostId = await configure(harness)
    ensureOwnerFixtureBinding(harness.dbPath, harness.secretStore)
    gitlab.calls.length = 0

    const rotated = await harness.ok('forgeInbox.rotateProjectEventSecret', {
      ownerHostId,
      repoId: 'repo-1'
    })

    expect(rotated).toMatchObject({ ownerHostId, repoId: 'repo-1', ok: true })
    expect(rotated.binding).toMatchObject({ rotationPending: false })
    expect(gitlab.calls.length).toBeGreaterThan(0)
    expect(gitlab.calls.every((call) => call.options?.cwd === '/trusted/repo')).toBe(true)
    const ledger = harness.openLedger(ownerHostId)
    const newSecret = readProjectBindingSecret(
      ledger.ledgerContext(),
      PROJECT_EVENT_BINDING_ID
    )?.secret
    expect(newSecret).toBeTruthy()
    if (!newSecret) {
      return
    }
    expect(newSecret).not.toBe(FIXTURE_TOKEN)
    expect(JSON.stringify(rotated)).not.toContain(FIXTURE_TOKEN)
    expect(JSON.stringify(rotated)).not.toContain(newSecret)
  })

  it('keeps the old secret and reports a failed write without exposing it', async () => {
    const gitlab = fakeGitlab({ projectId: 42 })
    harness = await createForgeRpcHarness({
      receiverSettings: createReceiverSettingsFixture(),
      ownerOptions: {
        resolveProjectBindingContext: () => ({
          ok: true,
          repoPath: '/trusted/repo',
          connectionId: null,
          source: 'repo',
          explicitProjectRefText: null
        }),
        projectBindingExec: gitlab.exec
      }
    })
    const ownerHostId = await configure(harness)
    ensureOwnerFixtureBinding(harness.dbPath, harness.secretStore)
    gitlab.setWriteStatus(403)

    const rotated = await harness.ok('forgeInbox.rotateProjectEventSecret', {
      ownerHostId,
      repoId: 'repo-1'
    })

    expect(rotated).toMatchObject({
      ownerHostId,
      repoId: 'repo-1',
      ok: false,
      code: 'forbidden',
      retryable: true
    })
    expect(rotated.binding).toMatchObject({ state: 'connected', rotationPending: false })
    expect(JSON.stringify(rotated)).not.toContain(FIXTURE_TOKEN)
    const ledger = harness.openLedger(ownerHostId)
    expect(readProjectBindingSecret(ledger.ledgerContext(), PROJECT_EVENT_BINDING_ID)?.secret).toBe(
      FIXTURE_TOKEN
    )
  })

  it('reports refused events as a failed binding after promoting the new secret', async () => {
    const gitlab = fakeGitlab({ projectId: 42, rejectEvents: ['releases_events'] })
    harness = await createForgeRpcHarness({
      receiverSettings: createReceiverSettingsFixture(),
      ownerOptions: {
        resolveProjectBindingContext: () => ({
          ok: true,
          repoPath: '/trusted/repo',
          connectionId: null,
          source: 'repo',
          explicitProjectRefText: null
        }),
        projectBindingExec: gitlab.exec
      }
    })
    const ownerHostId = await configure(harness)
    ensureOwnerFixtureBinding(harness.dbPath, harness.secretStore)

    const rotated = await harness.ok('forgeInbox.rotateProjectEventSecret', {
      ownerHostId,
      repoId: 'repo-1'
    })

    expect(rotated).toMatchObject({
      ownerHostId,
      repoId: 'repo-1',
      ok: false,
      code: 'event-configuration-rejected',
      retryable: false
    })
    expect(rotated.binding).toMatchObject({
      state: 'failed',
      failure: { phase: 'verifying', code: 'event-configuration-rejected' },
      rotationPending: false
    })
    expect(recordOf(rotated.binding).rejectedEvents).toContain('releases_events')
    const promoted = readProjectBindingSecret(
      harness.openLedger(ownerHostId).ledgerContext(),
      PROJECT_EVENT_BINDING_ID
    )?.secret
    expect(promoted).toBeTruthy()
    expect(JSON.stringify(rotated)).not.toContain(FIXTURE_TOKEN)
    expect(JSON.stringify(rotated)).not.toContain(promoted)
  })
})

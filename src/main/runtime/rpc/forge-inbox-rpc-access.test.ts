import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { FORGE_INBOX_RUNTIME_CAPABILITY } from '../../../shared/forge-inbox-runtime-capabilities'
import {
  CANARY,
  configure,
  createForgeRpcHarness,
  errorCodeOf,
  recordsOf,
  seedItem,
  type ForgeRpcHarness
} from './forge-inbox-rpc-test-kit'

const DATA_METHODS = [
  'forgeInbox.listItems',
  'forgeInbox.getItemDetail',
  'forgeInbox.listRuns',
  'forgeInbox.listEvents',
  'forgeInbox.getChanges',
  'forgeInbox.markRead'
] as const

function dataParams(method: string, ownerHostId: string, itemId = 1) {
  switch (method) {
    case 'forgeInbox.getItemDetail':
    case 'forgeInbox.listEvents':
    case 'forgeInbox.markRead':
      return { ownerHostId, itemId }
    case 'forgeInbox.getChanges':
      return { ownerHostId, afterSeq: 0 }
    default:
      return { ownerHostId }
  }
}

const STREAM_METHOD_PARAMS = (ownerHostId: string): [string, unknown][] => [
  ['forgeInbox.unsubscribeChanges', { subscriptionId: 'forge-inbox-changes-x-1' }],
  ['forgeInbox.ackChanges', { ownerHostId, subscriptionId: 'forge-inbox-changes-x-1', seq: 0 }],
  [
    'forgeInbox.updateProjectPolicy',
    { ownerHostId, instanceId: 'gitlab-main', projectId: '42', expectedRevision: 1, patch: {} }
  ]
]

describe('forge inbox rpc access', () => {
  let harness: ForgeRpcHarness
  afterEach(() => harness.close())

  it('keeps a never-configured host dormant for every read, with no file created', async () => {
    harness = await createForgeRpcHarness()
    const config = await harness.ok('forgeInbox.getConfig', {})
    const ownerHostId = String(config.ownerHostId)
    expect(config.configRevision).toBe(0)
    expect(ownerHostId.length).toBeGreaterThan(0)

    const status = await harness.ok('forgeInbox.getStatus', {})
    expect(status).toMatchObject({ ownerHostId, dormant: true })

    expect(await harness.ok('forgeInbox.listItems', { ownerHostId })).toMatchObject({
      rows: [],
      nextCursor: null
    })
    expect(await harness.ok('forgeInbox.getItemDetail', { ownerHostId, itemId: 1 })).toMatchObject({
      detail: null
    })
    expect(await harness.ok('forgeInbox.listRuns', { ownerHostId })).toMatchObject({ rows: [] })
    expect(await harness.ok('forgeInbox.listEvents', { ownerHostId, itemId: 1 })).toMatchObject({
      rows: []
    })
    expect(await harness.ok('forgeInbox.getChanges', { ownerHostId, afterSeq: 5 })).toMatchObject({
      changes: [],
      nextSeq: 5,
      hasMore: false
    })
    expect(await harness.ok('forgeInbox.markRead', { ownerHostId, itemId: 1 })).toMatchObject({
      marked: false
    })
    const { existsSync } = await import('node:fs')
    expect(existsSync(harness.dbPath)).toBe(false)
  })

  it('lets owner, desktop and paired standard callers read and administer; refuses mobile', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    for (const caller of ['cli', 'desktop', 'paired-a'] as const) {
      expect((await harness.call('forgeInbox.getStatus', {}, caller)).ok).toBe(true)
      expect((await harness.call('forgeInbox.listItems', { ownerHostId }, caller)).ok).toBe(true)
    }
    const config = await harness.ok('forgeInbox.getConfig', {}, 'paired-a')
    const admin = await harness.call(
      'forgeInbox.updateConfig',
      { ownerHostId, expectedRevision: config.configRevision, config: config.config },
      'paired-a'
    )
    expect(admin.ok).toBe(true)

    const mobileCalls: [string, unknown][] = [
      ['forgeInbox.getStatus', {}],
      ['forgeInbox.getConfig', {}],
      ['forgeInbox.listItems', { ownerHostId }],
      ['forgeInbox.updateConfig', { ownerHostId, expectedRevision: 1, config: {} }],
      [
        'forgeInbox.setCredential',
        {
          ownerHostId,
          instanceId: 'gitlab-main',
          kind: 'api-read',
          secret: 'x',
          expectedRevision: 1
        }
      ]
    ]
    for (const [method, params] of [...mobileCalls, ...STREAM_METHOD_PARAMS(ownerHostId)]) {
      const response = await harness.call(method, params, 'mobile')
      expect(response.ok).toBe(false)
      expect(errorCodeOf(response)).toBe('forbidden')
    }
  })

  it('fences every data and admin method to the durable owner host id', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const wrong = `${ownerHostId}-other`
    const calls: [string, unknown][] = [
      ...DATA_METHODS.map((m): [string, unknown] => [m, dataParams(m, wrong)]),
      ...STREAM_METHOD_PARAMS(wrong).filter(
        ([method]) => method !== 'forgeInbox.unsubscribeChanges'
      ),
      ['forgeInbox.updateConfig', { ownerHostId: wrong, expectedRevision: 1, config: {} }],
      [
        'forgeInbox.setCredential',
        {
          ownerHostId: wrong,
          instanceId: 'gitlab-main',
          kind: 'api-read',
          secret: 'glpat-x',
          expectedRevision: 1
        }
      ],
      [
        'forgeInbox.clearCredential',
        { ownerHostId: wrong, instanceId: 'gitlab-main', kind: 'api-read', expectedRevision: 1 }
      ]
    ]
    for (const [method, params] of calls) {
      const response = await harness.call(method, params)
      expect(errorCodeOf(response), method).toBe('forge_inbox_owner_mismatch')
      expect(JSON.stringify(response)).not.toContain(ownerHostId)
    }
  })

  it('rejects unknown keys, oversized limits and non-integer ids before touching the ledger', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const bad: [string, unknown][] = [
      ['forgeInbox.listItems', { ownerHostId, path: '/etc/passwd' }],
      ['forgeInbox.listItems', { ownerHostId, limit: 101 }],
      ['forgeInbox.listItems', { ownerHostId, limit: 0 }],
      ['forgeInbox.listItems', { ownerHostId, cursor: 1.5 }],
      ['forgeInbox.getItemDetail', { ownerHostId, itemId: 0 }],
      ['forgeInbox.getChanges', { ownerHostId, afterSeq: -1 }],
      ['forgeInbox.listItems', { ownerHostId, clientId: 'someone-else' }],
      ['forgeInbox.getStatus', { extra: true }]
    ]
    for (const [method, params] of bad) {
      expect((await harness.call(method, params)).ok, JSON.stringify(params)).toBe(false)
    }
  })

  it('keeps read marks per caller identity and never moves run state', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const ledger = harness.openLedger(ownerHostId)
    const { itemId } = seedItem(ledger, ownerHostId, 1)
    const runsBefore = await harness.ok('forgeInbox.listRuns', { ownerHostId })

    expect(
      await harness.ok('forgeInbox.markRead', { ownerHostId, itemId }, 'paired-a')
    ).toMatchObject({
      marked: true
    })
    const unread = (caller: 'paired-a' | 'paired-b') =>
      harness.ok('forgeInbox.listItems', { ownerHostId, unreadOnly: true }, caller)
    expect((await unread('paired-a')).rows).toEqual([])
    expect(recordsOf((await unread('paired-b')).rows)).toHaveLength(1)
    expect(await harness.ok('forgeInbox.listRuns', { ownerHostId })).toEqual(runsBefore)
  })

  it('refuses reads and marks from a caller with no stamped identity instead of sharing one', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    for (const method of [
      'forgeInbox.listItems',
      'forgeInbox.getItemDetail',
      'forgeInbox.markRead'
    ]) {
      const response = await harness.call(method, dataParams(method, ownerHostId), 'unidentified')
      expect(errorCodeOf(response), method).toBe('forge_inbox_caller_unidentified')
    }
  })

  it('keeps advertising the static capability for a stopped service while status reports it unavailable', async () => {
    harness = await createForgeRpcHarness()
    expect(harness.runtime.getStatus().capabilities).toEqual(
      expect.arrayContaining([
        FORGE_INBOX_RUNTIME_CAPABILITY,
        'forge-inbox.changes-stream.v1',
        'forge-inbox.project-policy.v1'
      ])
    )
    const ownerHostId = String((await harness.ok('forgeInbox.getConfig', {})).ownerHostId)
    await harness.stop()
    expect(harness.runtime.getStatus().capabilities).toContain(FORGE_INBOX_RUNTIME_CAPABILITY)

    const status = await harness.ok('forgeInbox.getStatus', {})
    expect(status).toMatchObject({ available: false, phase: 'stopped' })
    for (const [method, params] of [
      ['forgeInbox.getConfig', {}],
      ['forgeInbox.listItems', { ownerHostId }]
    ] as const) {
      const response = await harness.call(method, params)
      expect(errorCodeOf(response), method).toBe('forge_inbox_unavailable')
    }
  })

  it('reports an unattached host as unavailable without inventing an owner, and refuses everything else', async () => {
    harness = await createForgeRpcHarness({ attach: false })
    expect(await harness.ok('forgeInbox.getStatus', {})).toMatchObject({
      available: false,
      phase: 'unattached',
      ownerHostId: null
    })
    for (const [method, params] of [
      ['forgeInbox.getConfig', {}],
      ['forgeInbox.listItems', { ownerHostId: 'any-host' }],
      ['forgeInbox.updateConfig', { ownerHostId: 'any-host', expectedRevision: 0, config: {} }]
    ] as const) {
      expect(errorCodeOf(await harness.call(method, params)), method).toBe('runtime_unavailable')
    }
  })

  it('answers a storage failure in status with the fixed unavailable code, not the SQL diagnostic', async () => {
    harness = await createForgeRpcHarness()
    await configure(harness)
    const side = new Database(harness.dbPath)
    try {
      side.exec(
        `DROP TABLE webhook_deliveries; CREATE VIEW webhook_deliveries AS SELECT * FROM ${CANARY.replaceAll('-', '_')}_BACKEND_TABLE`
      )
      const response = await harness.call('forgeInbox.getStatus', {})
      expect(errorCodeOf(response)).toBe('forge_inbox_unavailable')
      expect(JSON.stringify(response)).not.toContain('BACKEND_TABLE')
    } finally {
      side.close()
    }
  })

  it('has no route that reveals a stored secret', async () => {
    harness = await createForgeRpcHarness()
    for (const method of [
      'forgeInbox.readSecret',
      'forgeInbox.getSecret',
      'forgeInbox.revealCredential'
    ]) {
      const response = await harness.call(method, {})
      expect(errorCodeOf(response)).toBe('method_not_found')
    }
  })
})

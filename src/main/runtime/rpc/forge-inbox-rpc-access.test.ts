import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { FORGE_INBOX_RUNTIME_CAPABILITY } from '../../../shared/forge-inbox-runtime-capabilities'
import { PROJECT_EVENT_RECEIVER_LISTENER_ERROR_CODES } from '../../../shared/project-event-receiver-listener-error-codes'
import { holdPort } from '../../forge-inbox/forge-inbox-owner-service-test-ports'
import { INSTANCE_ID } from '../../forge-inbox/forge-inbox-webhook-test-harness'
import { createReceiverSettingsFixture } from '../../project-events/project-event-receiver-settings-test-fixture'
import {
  CANARY,
  configure,
  createForgeRpcHarness,
  enabledConfig,
  errorCodeOf,
  recordsOf,
  seedItem,
  type ForgeRpcHarness
} from './forge-inbox-rpc-test-kit'

const DATA_METHODS = [
  'forgeInbox.listItems',
  'forgeInbox.listProjects',
  'forgeInbox.getItemDetail',
  'forgeInbox.listRuns',
  'forgeInbox.listEvents',
  'forgeInbox.getChanges',
  'forgeInbox.markRead',
  'forgeInbox.archiveItem',
  'forgeInbox.unarchiveItem'
] as const

function dataParams(method: string, ownerHostId: string, itemId = 1) {
  switch (method) {
    case 'forgeInbox.getItemDetail':
    case 'forgeInbox.listEvents':
    case 'forgeInbox.markRead':
    case 'forgeInbox.archiveItem':
    case 'forgeInbox.unarchiveItem':
      return { ownerHostId, itemId }
    case 'forgeInbox.getChanges':
      return { ownerHostId, afterSeq: 0 }
    default:
      return { ownerHostId }
  }
}

const STREAM_METHOD_PARAMS = (ownerHostId: string): [string, unknown][] => [
  ['forgeInbox.unsubscribeChanges', { subscriptionId: 'forge-inbox-changes-x-1' }],
  ['forgeInbox.ackChanges', { ownerHostId, subscriptionId: 'forge-inbox-changes-x-1', seq: 0 }]
]

describe('forge inbox rpc access', () => {
  let harness: ForgeRpcHarness
  afterEach(() => harness.close())

  it('keeps a never-configured host dormant for every read, with no file created', async () => {
    harness = await createForgeRpcHarness()
    const status = await harness.ok('forgeInbox.getStatus', {})
    const ownerHostId = String(status.ownerHostId)
    expect(harness.runtime.forgeInboxService().getConfig().configRevision).toBe(0)
    expect(ownerHostId.length).toBeGreaterThan(0)
    expect(status).toMatchObject({ ownerHostId, dormant: true, unread: 0 })

    expect(await harness.ok('forgeInbox.listItems', { ownerHostId })).toMatchObject({
      rows: [],
      nextCursor: null
    })
    expect(await harness.ok('forgeInbox.listProjects', { ownerHostId })).toEqual({
      ownerHostId,
      projects: []
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

  it('lets owner, desktop and paired standard callers use current routes; refuses mobile', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    for (const caller of ['cli', 'desktop', 'paired-a'] as const) {
      expect((await harness.call('forgeInbox.getStatus', {}, caller)).ok).toBe(true)
      expect((await harness.call('forgeInbox.listItems', { ownerHostId }, caller)).ok).toBe(true)
    }
    const policy = await harness.call(
      'forgeInbox.getProjectEventPolicy',
      { ownerHostId, repoId: 'repo-1' },
      'paired-a'
    )
    expect(policy.ok).toBe(true)

    const mobileCalls: [string, unknown][] = [
      ['forgeInbox.getStatus', {}],
      ['forgeInbox.getConfig', {}],
      ['forgeInbox.listItems', { ownerHostId }],
      ['forgeInbox.archiveItem', { ownerHostId, itemId: 1 }],
      ['forgeInbox.unarchiveItem', { ownerHostId, itemId: 1 }],
      ['forgeInbox.updateConfig', { ownerHostId, expectedRevision: 1, config: {} }],
      ['forgeInbox.getProjectEventPolicy', { ownerHostId, repoId: 'repo-1' }],
      [
        'forgeInbox.updateProjectEventPolicy',
        { ownerHostId, repoId: 'repo-1', expectedGeneration: 0, patch: {} }
      ],
      ['forgeInbox.retryProjectEvent', { ownerHostId, repoId: 'repo-1' }],
      ['forgeInbox.getProjectEventActivity', { ownerHostId, repoId: 'repo-1' }],
      ['forgeInbox.rotateProjectEventSecret', { ownerHostId, repoId: 'repo-1' }],
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
      ['forgeInbox.getProjectEventPolicy', { ownerHostId: wrong, repoId: 'repo-1' }],
      [
        'forgeInbox.updateProjectEventPolicy',
        { ownerHostId: wrong, repoId: 'repo-1', expectedGeneration: 0, patch: {} }
      ],
      ['forgeInbox.retryProjectEvent', { ownerHostId: wrong, repoId: 'repo-1' }],
      ['forgeInbox.getProjectEventActivity', { ownerHostId: wrong, repoId: 'repo-1' }],
      ['forgeInbox.rotateProjectEventSecret', { ownerHostId: wrong, repoId: 'repo-1' }]
    ]
    for (const [method, params] of calls) {
      const response = await harness.call(method, params)
      expect(errorCodeOf(response), method).toBe('forge_inbox_owner_mismatch')
      expect(JSON.stringify(response)).not.toContain(ownerHostId)
    }
  })

  it('fences a policy write when lazy open discovers a different owner', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = String((await harness.ok('forgeInbox.getStatus', {})).ownerHostId)
    const external = harness.openLedger('external-owner')
    const before = external.getProjectEventPolicy('repo-1')

    const response = await harness.call('forgeInbox.updateProjectEventPolicy', {
      ownerHostId,
      repoId: 'repo-1',
      expectedGeneration: 0,
      patch: { rules: 'not saved' }
    })

    expect(errorCodeOf(response)).toBe('forge_inbox_owner_mismatch')
    expect(JSON.stringify(response)).not.toContain('external-owner')
    expect(external.getProjectEventPolicy('repo-1')).toEqual(before)
  })

  it('rejects unknown keys, oversized limits and non-integer ids before touching the ledger', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const bad: [string, unknown][] = [
      ['forgeInbox.listItems', { ownerHostId, path: '/etc/passwd' }],
      ['forgeInbox.listItems', { ownerHostId, limit: 101 }],
      ['forgeInbox.listItems', { ownerHostId, limit: 0 }],
      ['forgeInbox.getProjectEventActivity', { ownerHostId, repoId: 'repo-1', limit: 0 }],
      ['forgeInbox.getProjectEventActivity', { ownerHostId, repoId: 'repo-1', limit: 21 }],
      ['forgeInbox.listItems', { ownerHostId, cursor: 1.5 }],
      ['forgeInbox.getItemDetail', { ownerHostId, itemId: 0 }],
      ['forgeInbox.getChanges', { ownerHostId, afterSeq: -1 }],
      ['forgeInbox.listItems', { ownerHostId, clientId: 'someone-else' }],
      ['forgeInbox.listItems', { ownerHostId, kind: 'label' }],
      ['forgeInbox.listItems', { ownerHostId, projectId: 42 }],
      ['forgeInbox.listItems', { ownerHostId, projectFilter: 'group/demo' }],
      ['forgeInbox.listItems', { ownerHostId, handling: 'read' }],
      ['forgeInbox.getStatus', { extra: true }]
    ]
    for (const [method, params] of bad) {
      expect((await harness.call(method, params)).ok, JSON.stringify(params)).toBe(false)
    }
  })

  it('narrows the list to one project and one kind, and names the projects it holds', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const ledger = harness.openLedger(ownerHostId)
    const ingest = (projectId: string, kind: 'merge_request' | 'issue', iid: number) => {
      ledger.ingestEvent({
        hostId: ownerHostId,
        instanceId: INSTANCE_ID,
        projectId,
        kind,
        iid,
        dedupeKey: `${projectId}-${kind}-${iid}`,
        eventKind: `${kind}.updated`,
        payload: { category: 'review-request', completeness: { complete: true } },
        versionToken: `v${iid}`,
        sourceOrder: iid,
        title: `${kind} ${iid}`,
        itemState: 'opened'
      })
    }
    ingest('group/demo', 'merge_request', 7)
    ingest('group/demo', 'issue', 8)
    ingest('other/tool', 'merge_request', 9)

    const titles = async (query: Record<string, unknown>) =>
      recordsOf((await harness.ok('forgeInbox.listItems', { ownerHostId, ...query })).rows).map(
        (row) => row.title
      )

    expect(await titles({})).toHaveLength(3)
    expect(await titles({ projectId: 'other/tool' })).toEqual(['merge_request 9'])
    expect(await titles({ kind: 'issue' })).toEqual(['issue 8'])
    expect(await titles({ projectId: 'group/demo', kind: 'merge_request' })).toEqual([
      'merge_request 7'
    ])
    // Why: hook-only items derive `recorded`, so the state filter reads the same rows.
    expect(await titles({ handling: 'recorded' })).toHaveLength(3)
    expect(await titles({ handling: 'needs-user' })).toEqual([])
    expect(await harness.ok('forgeInbox.listProjects', { ownerHostId })).toEqual({
      ownerHostId,
      projects: ['group/demo', 'other/tool']
    })
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

  it('keeps archive marks per caller identity, hides them from the default list and never moves run state', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const ledger = harness.openLedger(ownerHostId)
    const { itemId } = seedItem(ledger, ownerHostId, 1)
    const runsBefore = await harness.ok('forgeInbox.listRuns', { ownerHostId })
    const list = (caller: 'paired-a' | 'paired-b', archiveView?: string) =>
      harness.ok(
        'forgeInbox.listItems',
        { ownerHostId, ...(archiveView ? { archiveView } : {}) },
        caller
      )

    expect(
      await harness.ok('forgeInbox.archiveItem', { ownerHostId, itemId }, 'paired-a')
    ).toMatchObject({ applied: true })

    expect((await list('paired-a')).rows).toEqual([])
    expect(recordsOf((await list('paired-a', 'archived')).rows)).toHaveLength(1)
    expect(recordsOf((await list('paired-b')).rows)).toHaveLength(1)
    expect(await harness.ok('forgeInbox.listRuns', { ownerHostId })).toEqual(runsBefore)

    expect(
      await harness.ok('forgeInbox.unarchiveItem', { ownerHostId, itemId }, 'paired-a')
    ).toMatchObject({ applied: true })
    expect(recordsOf((await list('paired-a')).rows)).toHaveLength(1)
    expect(
      (await harness.call('forgeInbox.listItems', { ownerHostId, archiveView: 'nope' })).ok
    ).toBe(false)
  })

  it('refuses reads and marks from a caller with no stamped identity instead of sharing one', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    for (const method of [
      'forgeInbox.listItems',
      'forgeInbox.getItemDetail',
      'forgeInbox.markRead',
      'forgeInbox.archiveItem',
      'forgeInbox.unarchiveItem'
    ]) {
      const response = await harness.call(method, dataParams(method, ownerHostId), 'unidentified')
      expect(errorCodeOf(response), method).toBe('forge_inbox_caller_unidentified')
    }
  })

  it.each([
    'forgeInbox.getConfig',
    'forgeInbox.updateConfig',
    'forgeInbox.setCredential',
    'forgeInbox.clearCredential'
  ])('rejects retired management method %s after caller admission', async (method) => {
    harness = await createForgeRpcHarness()
    const ownerHostId = String((await harness.ok('forgeInbox.getStatus', {})).ownerHostId)
    const service = harness.runtime.forgeInboxService()
    const setup = await service.updateConfig(0, enabledConfig(), ownerHostId)
    expect(setup.ok).toBe(true)
    const params = () => {
      const { configRevision, config } = service.getConfig()
      switch (method) {
        case 'forgeInbox.updateConfig':
          return { ownerHostId, expectedRevision: configRevision, config }
        case 'forgeInbox.setCredential':
          return {
            ownerHostId,
            instanceId: INSTANCE_ID,
            kind: 'api-read',
            expectedRevision: configRevision,
            secret: 'test-secret'
          }
        case 'forgeInbox.clearCredential':
          return {
            ownerHostId,
            instanceId: INSTANCE_ID,
            kind: 'api-read',
            expectedRevision: configRevision
          }
        default:
          return {}
      }
    }
    expect(errorCodeOf(await harness.call(method, params(), 'mobile'))).toBe('forbidden')
    for (const caller of ['cli', 'desktop', 'paired-a'] as const) {
      expect
        .soft(errorCodeOf(await harness.call(method, params(), caller)), caller)
        .toBe('method_not_found')
    }
  })

  it.each([
    'forgeInbox.updateProjectPolicy',
    'forgeInbox.proposePatch',
    'forgeInbox.proposePush',
    'forgeInbox.discuss',
    'forgeInbox.getProposal',
    'forgeInbox.getProposalDiff',
    'forgeInbox.approveComment',
    'forgeInbox.approvePatch',
    'forgeInbox.approvePush',
    'forgeInbox.rejectProposal'
  ])('rejects retired method %s as unknown', async (method) => {
    harness = await createForgeRpcHarness()
    expect(errorCodeOf(await harness.call(method, {}))).toBe('method_not_found')
  })

  it('advertises project event capabilities without the retired project policy capability', async () => {
    harness = await createForgeRpcHarness()
    const capabilities = harness.runtime.getStatus().capabilities
    expect(capabilities).toContain('forge-inbox.project-event-policy.v1')
    expect(capabilities).toContain('forge-inbox.project-event-agent.v1')
    expect(capabilities).not.toContain('forge-inbox.project-policy.v1')
  })

  it('keeps advertising the static capability for a stopped service while status reports it unavailable', async () => {
    harness = await createForgeRpcHarness()
    expect(harness.runtime.getStatus().capabilities).toEqual(
      expect.arrayContaining([
        FORGE_INBOX_RUNTIME_CAPABILITY,
        'forge-inbox.changes-stream.v1',
        'forge-inbox.project-event-policy.v1',
        'forge-inbox.project-event-agent.v1',
        'forge-inbox.item-archive.v1'
      ])
    )
    expect(harness.runtime.getStatus().capabilities).not.toContain('forge-inbox.project-policy.v1')
    const ownerHostId = String((await harness.ok('forgeInbox.getStatus', {})).ownerHostId)
    await harness.stop()
    expect(harness.runtime.getStatus().capabilities).toContain(FORGE_INBOX_RUNTIME_CAPABILITY)

    const status = await harness.ok('forgeInbox.getStatus', {})
    expect(status).toMatchObject({ available: false, phase: 'stopped' })
    for (const [method, params] of [
      ['forgeInbox.listItems', { ownerHostId }],
      ['forgeInbox.getProjectEventPolicy', { ownerHostId, repoId: 'repo-1' }]
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
    expect(await harness.ok('forgeInbox.retryReceiver', {})).toMatchObject({
      available: false,
      phase: 'unattached',
      ownerHostId: null
    })
    for (const [method, params] of [
      ['forgeInbox.listItems', { ownerHostId: 'any-host' }],
      ['forgeInbox.getProjectEventPolicy', { ownerHostId: 'any-host', repoId: 'repo-1' }]
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

  it('rebinds the real receiver socket only on retry and keeps the configured port', async () => {
    const receiverSettings = createReceiverSettingsFixture()
    harness = await createForgeRpcHarness({ receiverSettings })
    const held = await holdPort()
    receiverSettings.update({
      enabled: true,
      bindAddress: '127.0.0.1',
      port: held.port,
      externalBaseUrl: '',
      acknowledgeExternalPlaintextHttp: false
    })

    const blocked = await harness.ok('forgeInbox.retryReceiver', {})
    expect(blocked.listener).toMatchObject({
      listening: false,
      error: PROJECT_EVENT_RECEIVER_LISTENER_ERROR_CODES.addressInUse
    })

    await held.release()
    expect((await harness.ok('forgeInbox.retryReceiver', {})).listener).toMatchObject({
      listening: true,
      port: held.port,
      error: null
    })

    expect((await harness.call('forgeInbox.retryReceiver', {}, 'desktop')).ok).toBe(true)
    expect((await harness.call('forgeInbox.retryReceiver', {}, 'paired-a')).ok).toBe(true)
    expect(errorCodeOf(await harness.call('forgeInbox.retryReceiver', {}, 'mobile'))).toBe(
      'forbidden'
    )
  })

  it('reports a stopped owner instead of reconciling the receiver', async () => {
    harness = await createForgeRpcHarness()
    await harness.stop()

    await expect(harness.ok('forgeInbox.retryReceiver', {})).resolves.toMatchObject({
      available: false,
      phase: 'stopped'
    })
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

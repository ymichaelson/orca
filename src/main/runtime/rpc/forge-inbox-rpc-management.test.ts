import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SecretStore } from '../../../shared/secret-store'
import { fakeSecretStore, INSTANCE_ID } from '../../forge-inbox/forge-inbox-webhook-test-harness'
import {
  CANARY,
  configure,
  createForgeRpcHarness,
  enabledConfig,
  errorCodeOf,
  type ForgeRpcHarness
} from './forge-inbox-rpc-test-kit'

describe('forge inbox rpc management', () => {
  let harness: ForgeRpcHarness
  afterEach(() => harness.close())

  const credential = (ownerHostId: string, expectedRevision: number, secret: string) => ({
    ownerHostId,
    instanceId: INSTANCE_ID,
    kind: 'api-read',
    secret,
    expectedRevision
  })

  it('creates the ledger on the first config write and rejects a stale revision without changing it', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const view = await harness.ok('forgeInbox.getConfig', {})
    expect(view.configRevision).toBe(1)

    const stale = await harness.ok('forgeInbox.updateConfig', {
      ownerHostId,
      expectedRevision: 0,
      config: { schemaVersion: 1, listener: {}, instances: [] }
    })
    expect(stale).toMatchObject({ ok: false, reason: 'stale-revision', configRevision: 1 })
    expect(await harness.ok('forgeInbox.getConfig', {})).toEqual(view)
  })

  it('rejects an invalid config without echoing submitted values', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const response = await harness.call('forgeInbox.updateConfig', {
      ownerHostId,
      expectedRevision: 1,
      config: { ...enabledConfig(), listener: { port: CANARY } }
    })
    expect(JSON.stringify(response)).not.toContain(CANARY)
    expect(response.ok && response.result).toMatchObject({ ok: false, reason: 'invalid-config' })
  })

  it('stores a credential, reports presence only, and keeps the stored value on a stale write', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const saved = await harness.ok(
      'forgeInbox.setCredential',
      credential(ownerHostId, 1, 'glpat-first')
    )
    expect(saved).toMatchObject({ ok: true })
    const revision = Number(saved.configRevision)

    const stale = await harness.ok(
      'forgeInbox.setCredential',
      credential(ownerHostId, revision - 1, 'glpat-second')
    )
    expect(stale).toMatchObject({ ok: false, reason: 'stale-revision', configRevision: revision })

    expect(harness.openLedger(ownerHostId).readSecret(INSTANCE_ID, 'api-read')?.secret).toBe(
      'glpat-first'
    )
    const view = await harness.ok('forgeInbox.getConfig', {})
    expect(JSON.stringify(view)).not.toMatch(/glpat-(first|second)/)
    expect(view.credentials).toEqual([
      expect.objectContaining({ instanceId: INSTANCE_ID, kind: 'api-read' })
    ])
    const cleared = await harness.ok('forgeInbox.clearCredential', {
      ownerHostId,
      instanceId: INSTANCE_ID,
      kind: 'api-read',
      expectedRevision: revision
    })
    expect(cleared).toMatchObject({ ok: true })
    expect((await harness.ok('forgeInbox.getConfig', {})).credentials).toEqual([])
  })

  it.each([
    ['padded with spaces', ' glpat-x '],
    ['containing a newline', 'glpat-x\n'],
    ['non-ASCII', 'glpat-é'],
    ['empty', ''],
    ['over the byte bound', 'a'.repeat(8 * 1024 + 1)]
  ])('rejects a secret %s without trimming it into a valid one', async (_label, secret) => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const response = await harness.call(
      'forgeInbox.setCredential',
      credential(ownerHostId, 1, secret)
    )
    expect(errorCodeOf(response)).toBe('invalid_argument')
    expect(JSON.stringify(response)).not.toContain(secret || CANARY)
    expect((await harness.ok('forgeInbox.getConfig', {})).credentials).toEqual([])
  })

  it('maps a throwing secret store to a fixed failure that leaks neither the error nor the secret', async () => {
    const throwing: SecretStore = {
      ...fakeSecretStore(),
      encryptString: vi.fn(() => {
        throw new Error(`keychain exploded with ${CANARY}`)
      })
    }
    harness = await createForgeRpcHarness({ secretStore: throwing })
    const ownerHostId = await configure(harness)
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let response
    let logged
    try {
      response = await harness.call(
        'forgeInbox.setCredential',
        credential(ownerHostId, 1, `glpat-${CANARY}`)
      )
      logged = JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls])
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
    }
    expect(JSON.stringify(response)).not.toContain(CANARY)
    expect(logged).not.toContain(CANARY)
    expect(errorCodeOf(response)).toBe('forge_inbox_credential_unavailable')
    expect((await harness.ok('forgeInbox.getConfig', {})).credentials).toEqual([])
  })

  it('refuses a first write that lazy-opens a ledger owned by a different host, leaving it untouched', async () => {
    harness = await createForgeRpcHarness()
    const discovered = String((await harness.ok('forgeInbox.getConfig', {})).ownerHostId)
    const external = harness.openLedger('external-owner')
    expect(external.hostId).not.toBe(discovered)

    const update = await harness.call('forgeInbox.updateConfig', {
      ownerHostId: discovered,
      expectedRevision: 0,
      config: enabledConfig()
    })
    const credentialWrite = await harness.call(
      'forgeInbox.setCredential',
      credential(discovered, 0, 'glpat-late')
    )
    expect(errorCodeOf(update)).toBe('forge_inbox_owner_mismatch')
    expect(errorCodeOf(credentialWrite)).toBe('forge_inbox_owner_mismatch')
    expect(JSON.stringify([update, credentialWrite])).not.toContain('external-owner')
    expect(external.getConfig()).toMatchObject({ configRevision: 0, credentials: [] })
    expect(external.getConfig().config.instances).toEqual([])
  })
})

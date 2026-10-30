import '../unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/vitest-host-ports-setup'
import { setSecretStore } from '../../../../shared/secret-store'
import { Store } from '../../../persistence/loading-store/store'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson
} from '../../../persistence-test-harness'
import { createForgeInboxOwnerService } from '../../../forge-inbox/forge-inbox-owner-service'
import { fakeSecretStore } from '../../../forge-inbox/forge-inbox-webhook-test-harness'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { PROJECT_EVENT_DECISION_SETTINGS_METHODS } from './project-event-decision-settings'
import { CLIENT_UI_METHODS } from './client-ui'

const KEY = 'decision-secret-CANARY'
const CAPABILITY = 'project-events.decision-settings.v1'
const metadata = { provider: 'laya', model: 'small', baseUrl: 'http://127.0.0.1:9000/' }

describe('host decision settings RPC', () => {
  let root: string
  let store: Store
  let runtime: OrcaRuntimeService
  let dispatcher: RpcDispatcher
  let ownerHostId: string
  let protectedStorage: boolean
  let gap: boolean
  let service: ReturnType<typeof createForgeInboxOwnerService>
  const call = (method: string, params: unknown = {}, mobile = false) =>
    dispatcher.dispatch(
      { id: method, authToken: 'test', method, params },
      mobile
        ? { clientKind: 'mobile', callerScope: { kind: 'mobile' } }
        : { callerScope: { kind: 'runtime-paired', grants: [] }, pairedDeviceId: 'desktop' }
    )

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'decision-settings-rpc-'))
    installFakeAppEnvironment({ getPath: () => root })
    protectedStorage = true
    gap = false
    setSecretStore({
      isEncryptionAvailable: () => protectedStorage,
      describeProtectionGap: () => (gap ? KEY : null),
      encryptString: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 42)),
      decryptString: (value) =>
        Buffer.from(value)
          .map((byte) => byte ^ 42)
          .toString()
    })
    store = createSqliteTestStore(Store, { dataFile: join(root, 'orca-data.json') })
    runtime = new OrcaRuntimeService(store)
    service = createForgeInboxOwnerService({
      dbPath: join(root, 'inbox.sqlite'),
      secretStore: fakeSecretStore(),
      http: { fetch: () => Promise.reject(new Error('no network')) }
    })
    runtime.attachForgeInboxService(service)
    await service.start()
    ownerHostId = service.ownerHostId()
    dispatcher = new RpcDispatcher({
      runtime,
      methods: [...PROJECT_EVENT_DECISION_SETTINGS_METHODS, ...CLIENT_UI_METHODS]
    })
  })

  afterEach(async () => {
    await service.stop()
    await closeTestStores()
    rmSync(root, { recursive: true, force: true })
  })

  it('advertises management and returns only metadata and per-provider key status', async () => {
    expect(runtime.getStatus().capabilities).toContain(CAPABILITY)
    const saved = await call('projectEventDecision.saveSettings', {
      ownerHostId,
      settings: metadata
    })
    expect(saved).toMatchObject({
      ok: true,
      result: {
        ownerHostId,
        settings: { ...metadata, apiKeysSaved: { jev: false, laya: false } },
        protection: 'available'
      }
    })
    const key = await call('projectEventDecision.saveApiKey', {
      ownerHostId,
      provider: 'jev',
      apiKey: KEY
    })
    expect(key).toMatchObject({
      ok: true,
      result: { settings: { ...metadata, apiKeysSaved: { jev: true, laya: false } } }
    })
    expect(JSON.stringify(key)).not.toContain(KEY)
    expect(store.getSettings().projectEventDecisionKey).toBe(KEY)
    expect(store.getSettings().projectEventDecisionLayaKey).toBe('')
    expect(runtime.getClientSettings().projectEventDecision).toEqual({
      ...metadata,
      apiKeysSaved: { jev: true, laya: false },
      apiKeysSealed: { jev: false, laya: false }
    })
    expect(await call('projectEventDecision.getSettings', { ownerHostId })).toMatchObject({
      ok: true,
      result: { settings: { apiKeysSaved: { jev: true, laya: false } } }
    })
    store.flushOrThrow()
    await store.waitForPendingWrite()
    expect(readPersistedStateJson(join(root, 'orca-data.json'))).not.toContain(KEY)
    expect(
      await call('projectEventDecision.clearApiKey', { ownerHostId, provider: 'jev' })
    ).toMatchObject({
      ok: true,
      result: { settings: { apiKeysSaved: { jev: false, laya: false } } }
    })
    expect(store.getSettings().projectEventDecisionKey).toBe('')
  })

  it('keeps each provider key when the other provider is saved or cleared', async () => {
    await call('projectEventDecision.saveApiKey', { ownerHostId, provider: 'jev', apiKey: KEY })
    await call('projectEventDecision.saveApiKey', {
      ownerHostId,
      provider: 'laya',
      apiKey: 'laya-key'
    })
    expect(store.getSettings().projectEventDecisionKey).toBe(KEY)
    expect(store.getSettings().projectEventDecisionLayaKey).toBe('laya-key')
    expect(
      await call('projectEventDecision.clearApiKey', { ownerHostId, provider: 'laya' })
    ).toMatchObject({
      ok: true,
      result: { settings: { apiKeysSaved: { jev: true, laya: false } } }
    })
    expect(store.getSettings().projectEventDecisionKey).toBe(KEY)
    expect(store.getSettings().projectEventDecisionLayaKey).toBe('')
  })

  it.each(['', ' ', 'a\nb', 'x'.repeat(8193), 123, null])(
    'rejects malformed secrets without mutation (%#)',
    async (apiKey) => {
      const before = store.getSettings()
      expect(
        await call('projectEventDecision.saveApiKey', { ownerHostId, provider: 'jev', apiKey })
      ).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
      expect(store.getSettings()).toEqual(before)
    }
  )

  it('rejects unknown fields, malformed metadata and foreign hosts before writing', async () => {
    const before = store.getSettings()
    expect(
      await call('projectEventDecision.saveApiKey', {
        ownerHostId,
        provider: 'jev',
        apiKey: KEY,
        extra: true
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(
      await call('projectEventDecision.saveApiKey', {
        ownerHostId: 'other-host',
        provider: 'jev',
        apiKey: KEY
      })
    ).toMatchObject({ ok: false, error: { message: 'project_event_decision_unavailable' } })
    expect(
      await call('projectEventDecision.saveSettings', {
        ownerHostId,
        settings: { ...metadata, baseUrl: 'http://user:secret@localhost' }
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(store.getSettings()).toEqual(before)
  })

  it('does not echo secrets submitted as unknown field names in schema errors', async () => {
    const before = store.getSettings()
    for (const [method, params] of [
      ['saveApiKey', { ownerHostId, provider: 'jev', apiKey: KEY, [KEY]: true }],
      ['clearApiKey', { ownerHostId, provider: 'jev', [KEY]: true }],
      ['getSettings', { ownerHostId, [KEY]: true }],
      ['saveSettings', { ownerHostId, settings: { ...metadata, [KEY]: true } }]
    ] as const) {
      const response = await call(`projectEventDecision.${method}`, params)
      expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
      expect(JSON.stringify(response)).not.toContain(KEY)
    }
    expect(store.getSettings()).toEqual(before)
  })

  it('keeps generic paired settings metadata-only and never returns a raw key', async () => {
    await call('projectEventDecision.saveApiKey', { ownerHostId, provider: 'jev', apiKey: KEY })
    expect(await call('settings.update', { projectEventDecisionKey: 'bypass' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(await call('settings.update', { projectEventDecisionLayaKey: 'bypass' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(await call('settings.update', { projectEventDecision: metadata })).toMatchObject({
      ok: true
    })
    expect(store.getSettings().projectEventDecisionKey).toBe(KEY)
    const response = await call('settings.get')
    expect(JSON.stringify(response)).not.toContain(KEY)
    expect(response).toMatchObject({
      ok: true,
      result: {
        settings: {
          projectEventDecision: { ...metadata, apiKeysSaved: { jev: true, laya: false } }
        }
      }
    })
  })

  it('reports throwing protection probes without their diagnostic values', async () => {
    setSecretStore({
      isEncryptionAvailable: () => {
        throw new Error(KEY)
      },
      describeProtectionGap: () => {
        throw new Error(KEY)
      },
      encryptString: () => {
        throw new Error(KEY)
      },
      decryptString: () => {
        throw new Error(KEY)
      }
    })
    const response = await call('projectEventDecision.getSettings', { ownerHostId })
    expect(response).toMatchObject({ ok: true, result: { protection: 'unavailable' } })
    expect(JSON.stringify(response)).not.toContain(KEY)
    expect(
      await call('projectEventDecision.saveApiKey', { ownerHostId, provider: 'jev', apiKey: KEY })
    ).toMatchObject({ ok: false, error: { message: 'project_event_decision_unavailable' } })
    expect(store.getSettings().projectEventDecisionKey).toBe('')
  })

  it('does not expand mobile credential permission', async () => {
    for (const method of ['saveApiKey', 'clearApiKey']) {
      expect(
        await call(
          `projectEventDecision.${method}`,
          { ownerHostId, provider: 'jev', ...(method === 'saveApiKey' ? { apiKey: KEY } : {}) },
          true
        )
      ).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expect(store.getSettings().projectEventDecisionKey).toBe('')
  })

  it.each(['unavailable', 'weak'] as const)(
    'reports %s protection, refuses save, but permits clear',
    async (state) => {
      await call('projectEventDecision.saveApiKey', { ownerHostId, provider: 'jev', apiKey: KEY })
      protectedStorage = state !== 'unavailable'
      gap = state === 'weak'
      const status = await call('projectEventDecision.getSettings', { ownerHostId })
      expect(status).toMatchObject({ ok: true, result: { protection: 'unavailable' } })
      expect(JSON.stringify(status)).not.toContain(KEY)
      const refused = await call('projectEventDecision.saveApiKey', {
        ownerHostId,
        provider: 'jev',
        apiKey: 'replacement'
      })
      expect(refused).toMatchObject({
        ok: false,
        error: { message: 'project_event_decision_unavailable' }
      })
      expect(store.getSettings().projectEventDecisionKey).toBe(KEY)
      expect(
        await call('projectEventDecision.clearApiKey', { ownerHostId, provider: 'jev' })
      ).toMatchObject({
        ok: true,
        result: {
          settings: { apiKeysSaved: { jev: false, laya: false } },
          protection: 'unavailable'
        }
      })
      expect(store.getSettings().projectEventDecisionKey).toBe('')
    }
  )

  it('withholds capability and refuses all management when the owner is unattached', async () => {
    const unattached = new OrcaRuntimeService(store)
    const otherDispatcher = new RpcDispatcher({
      runtime: unattached,
      methods: PROJECT_EVENT_DECISION_SETTINGS_METHODS
    })
    expect(unattached.getStatus().capabilities).not.toContain(CAPABILITY)
    expect(new OrcaRuntimeService().getStatus().capabilities).not.toContain(CAPABILITY)
    const before = store.getSettings()
    for (const method of ['getSettings', 'saveSettings', 'saveApiKey', 'clearApiKey']) {
      const response = await otherDispatcher.dispatch({
        id: method,
        authToken: 'test',
        method: `projectEventDecision.${method}`,
        params: {
          ownerHostId,
          ...(method === 'saveSettings' ? { settings: metadata } : {}),
          ...(method === 'saveApiKey' ? { apiKey: KEY } : {}),
          ...(method === 'saveApiKey' || method === 'clearApiKey' ? { provider: 'jev' } : {})
        }
      })
      expect(response).toMatchObject({
        ok: false,
        error: { message: 'project_event_decision_unavailable' }
      })
    }
    expect(store.getSettings()).toEqual(before)
  })

  it('runs one probe for the authorized owner and returns no credential material', async () => {
    await call('projectEventDecision.saveApiKey', { ownerHostId, provider: 'jev', apiKey: KEY })
    const probe = vi.fn(async () => ({
      ok: true as const,
      provider: 'jev' as const,
      model: 'jev-latest',
      usedDefaultModel: true
    }))
    Object.defineProperty(runtime, 'probeDecisionConnection', { value: probe, configurable: true })
    const response = await call('projectEventDecision.testConnection', { ownerHostId })
    expect(response).toMatchObject({
      ok: true,
      result: { ok: true, provider: 'jev', model: 'jev-latest', usedDefaultModel: true }
    })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(response)).not.toContain(KEY)
  })

  it('refuses the probe for a foreign, unattached, malformed or mobile caller', async () => {
    const probe = vi.fn()
    Object.defineProperty(runtime, 'probeDecisionConnection', { value: probe, configurable: true })
    expect(
      await call('projectEventDecision.testConnection', { ownerHostId: 'other-host' })
    ).toMatchObject({ ok: false, error: { message: 'project_event_decision_unavailable' } })
    expect(
      await call('projectEventDecision.testConnection', { ownerHostId, extra: true })
    ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(await call('projectEventDecision.testConnection', { ownerHostId }, true)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' }
    })
    const unattached = new OrcaRuntimeService(store)
    const otherDispatcher = new RpcDispatcher({
      runtime: unattached,
      methods: PROJECT_EVENT_DECISION_SETTINGS_METHODS
    })
    expect(
      await otherDispatcher.dispatch({
        id: 'probe',
        authToken: 'test',
        method: 'projectEventDecision.testConnection',
        params: { ownerHostId }
      })
    ).toMatchObject({ ok: false, error: { message: 'project_event_decision_unavailable' } })
    expect(probe).not.toHaveBeenCalled()
  })

  it('sanitizes probe failures independent of stored or thrown values', async () => {
    await call('projectEventDecision.saveApiKey', { ownerHostId, provider: 'jev', apiKey: KEY })
    Object.defineProperty(runtime, 'probeDecisionConnection', {
      value: vi.fn(async () => {
        throw new Error(KEY)
      }),
      configurable: true
    })
    const response = await call('projectEventDecision.testConnection', { ownerHostId })
    expect(response).toMatchObject({
      ok: false,
      error: { message: 'project_event_decision_unavailable' }
    })
    expect(JSON.stringify(response)).not.toContain(KEY)
  })

  it('sanitizes backend read/write exceptions independent of submitted or stored values', async () => {
    vi.spyOn(store, 'updateSettings').mockImplementation(() => {
      throw new Error(KEY)
    })
    const response = await call('projectEventDecision.saveApiKey', {
      ownerHostId,
      provider: 'jev',
      apiKey: KEY
    })
    expect(response).toMatchObject({
      ok: false,
      error: { message: 'project_event_decision_unavailable' }
    })
    expect(JSON.stringify(response)).not.toContain(KEY)
    vi.spyOn(store, 'getSettings').mockImplementation(() => {
      throw new Error(KEY)
    })
    expect(await call('projectEventDecision.getSettings', { ownerHostId })).toMatchObject({
      ok: false,
      error: { message: 'project_event_decision_unavailable' }
    })
  })
})

import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson
} from './persistence-test-harness'
// STA-3442: httpProxyUrl is the only network setting stored via safeStorage.
// On macOS a keychain reset/denial makes decryptString throw at load, and the
// raw ciphertext then masqueraded as a configured proxy: applyElectronProxySettings
// silently fell back to DIRECT and the garbage re-persisted forever. These tests
// pin the recovery contract: undecryptable values stay sealed (never applied
// or destroyed), plaintext values survive as the upgrade path, and safeStorage
// failures cannot expose the proxy secret or kill unrelated saves.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import { PROTECTED_SECRET_SLOT } from './protected-secret-persistence'

const testState = { dir: '' }

vi.mock('./ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

const cipherState = {
  encryptionAvailable: true,
  availabilityThrows: false,
  decryptAlwaysThrows: false,
  protectionGap: false
}

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  session: { defaultSession: undefined }
}))

vi.mock('./telemetry/client', () => ({
  track: vi.fn()
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({ nth_repo_added: 2 })
}))

async function createStore() {
  const { setSecretStore } = await import('../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => {
      if (cipherState.availabilityThrows) {
        throw new Error('safeStorage cannot be used before the app is ready')
      }
      return cipherState.encryptionAvailable
    },
    encryptString: (plaintext) => Buffer.from(`enc:${randomUUID()}:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext) => {
      if (cipherState.decryptAlwaysThrows) {
        throw new Error('keychain access denied')
      }
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('enc:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('enc:'.length + 36 + 1)
    },
    describeProtectionGap: () => (cipherState.protectionGap ? 'unprotected-backend' : null)
  })
  const { Store, initDataPath } = await import('./persistence')
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

function dataFile(): string {
  return join(testState.dir, 'orca-data.json')
}

const PROXY_URL = 'http://127.0.0.1:8080'
const BYPASS_RULES = '<local>'

describe('httpProxyUrl secret recovery (STA-3442)', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    cipherState.encryptionAvailable = true
    cipherState.availabilityThrows = false
    cipherState.decryptAlwaysThrows = false
    cipherState.protectionGap = false
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('never uses an undecryptable decision key as plaintext and retains it for recovery', async () => {
    const store = await createStore()
    store.updateSettings({ projectEventDecisionKey: 'decision-key-fixture' })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()
    const encrypted = JSON.parse(readPersistedStateJson(dataFile())).settings
      .projectEventDecisionKey
    expect(encrypted).not.toBe('decision-key-fixture')

    cipherState.decryptAlwaysThrows = true
    const unavailable = await createStore()
    expect(unavailable.getSettings().projectEventDecisionKey).toBe('')
    unavailable.updateSettings({ httpProxyBypassRules: 'updated' })
    vi.advanceTimersByTime(1000)
    await unavailable.waitForPendingWrite()
    expect(JSON.parse(readPersistedStateJson(dataFile())).settings.projectEventDecisionKey).toBe(
      encrypted
    )

    cipherState.decryptAlwaysThrows = false
    const recovered = await createStore()
    expect(recovered.getSettings().projectEventDecisionKey).toBe('decision-key-fixture')
  })

  it('seals each provider decision key in its own slot and recovers both', async () => {
    const store = await createStore()
    store.updateSettings({
      projectEventDecisionKey: 'jev-key-fixture',
      projectEventDecisionLayaKey: 'laya-key-fixture'
    })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()
    const persisted = JSON.parse(readPersistedStateJson(dataFile())).settings
    expect(persisted.projectEventDecisionKey).not.toBe('jev-key-fixture')
    expect(persisted.projectEventDecisionLayaKey).not.toBe('laya-key-fixture')
    expect(persisted.projectEventDecisionLayaKey).not.toBe(persisted.projectEventDecisionKey)
    const reopened = await createStore()
    expect(reopened.getSettings().projectEventDecisionKey).toBe('jev-key-fixture')
    expect(reopened.getSettings().projectEventDecisionLayaKey).toBe('laya-key-fixture')
  })

  it('refuses a malformed Laya decision key', async () => {
    const store = await createStore()
    expect(() => store.updateSettings({ projectEventDecisionLayaKey: 'a\nb' })).toThrow(
      'Invalid project event decision key'
    )
    expect(store.getSettings().projectEventDecisionLayaKey ?? '').toBe('')
  })

  it('rejects a new decision key when protected storage is unavailable', async () => {
    const store = await createStore()
    cipherState.encryptionAvailable = false
    expect(() => store.updateSettings({ projectEventDecisionKey: 'must-not-be-applied' })).toThrow(
      'Protected storage is unavailable for the project event decision key'
    )
    expect(store.getSettings().projectEventDecisionKey).toBe('')
  })

  it('rejects a key on a backend that reports encryption available but no protection', async () => {
    const store = await createStore()
    cipherState.protectionGap = true
    expect(() => store.updateSettings({ projectEventDecisionKey: 'must-not-be-applied' })).toThrow(
      'Protected storage is unavailable for the project event decision key'
    )
    expect(store.getSettings().projectEventDecisionKey).toBe('')
  })

  it('reports a retained decision key as sealed so a client can still clear it', async () => {
    const store = await createStore()
    store.updateSettings({ projectEventDecisionLayaKey: 'laya-key-fixture' })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()
    cipherState.decryptAlwaysThrows = true
    const unavailable = await createStore()
    expect(unavailable.getSettings().projectEventDecisionLayaKey).toBe('')
    expect(
      unavailable.hasSealedProtectedSecret(PROTECTED_SECRET_SLOT.projectEventDecisionLayaKey)
    ).toBe(true)
    expect(
      unavailable.hasSealedProtectedSecret(PROTECTED_SECRET_SLOT.projectEventDecisionKey)
    ).toBe(false)

    unavailable.updateSettings({ projectEventDecisionLayaKey: '' })
    expect(
      unavailable.hasSealedProtectedSecret(PROTECTED_SECRET_SLOT.projectEventDecisionLayaKey)
    ).toBe(false)
  })

  it('can explicitly forget a sealed decision key while encryption is unavailable', async () => {
    const store = await createStore()
    store.updateSettings({ projectEventDecisionKey: 'decision-key-fixture' })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()
    cipherState.encryptionAvailable = false
    const unavailable = await createStore()
    expect(unavailable.getSettings().projectEventDecisionKey).toBe('')
    unavailable.updateSettings({ projectEventDecisionKey: '' })
    vi.advanceTimersByTime(1000)
    await unavailable.waitForPendingWrite()
    expect(JSON.parse(readPersistedStateJson(dataFile())).settings.projectEventDecisionKey).toBe('')
    cipherState.encryptionAvailable = true
    const reopened = await createStore()
    expect(reopened.getSettings().projectEventDecisionKey).toBe('')
  })

  async function seedConfiguredProxy() {
    const store = await createStore()
    store.updateSettings({ httpProxyUrl: PROXY_URL, httpProxyBypassRules: BYPASS_RULES })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()
    return store
  }

  it('persists the configured proxy across a restart and applies it as fixed_servers', async () => {
    await seedConfiguredProxy()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const persisted = JSON.parse(readPersistedStateJson(dataFile())) as {
      settings: { httpProxyUrl: string; httpProxyBypassRules: string }
    }
    // On disk the URL is ciphertext (base64 of the mock's enc: payload), never plaintext.
    expect(persisted.settings.httpProxyUrl).not.toBe(PROXY_URL)
    expect(Buffer.from(persisted.settings.httpProxyUrl, 'base64').toString('utf-8')).toMatch(
      /^enc:/
    )
    expect(persisted.settings.httpProxyBypassRules).toBe(BYPASS_RULES)

    const reloaded = await createStore()
    expect(reloaded.getSettings().httpProxyUrl).toBe(PROXY_URL)
    expect(reloaded.getSettings().httpProxyBypassRules).toBe(BYPASS_RULES)

    const { applyElectronProxySettings, resetProxyApplicationForTests } =
      await import('./network/proxy-settings')
    resetProxyApplicationForTests()
    const setProxy = vi.fn(async () => {})
    const result = await applyElectronProxySettings(reloaded.getSettings(), {
      proxySession: { resolveProxy: async () => 'DIRECT', setProxy },
      env: {}
    })
    expect(result).toEqual({
      source: 'settings',
      proxyRules: PROXY_URL,
      proxyBypassRules: BYPASS_RULES
    })
    expect(setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: PROXY_URL,
      proxyBypassRules: BYPASS_RULES
    })
  })

  it('seals an undecryptable httpProxyUrl without destroying its ciphertext', async () => {
    await seedConfiguredProxy()
    const originalCiphertext = JSON.parse(readPersistedStateJson(dataFile())).settings.httpProxyUrl

    // Keychain reset/denial: every decrypt now fails.
    cipherState.decryptAlwaysThrows = true
    const reloaded = await createStore()

    expect(reloaded.getSettings().httpProxyUrl).toBe('')
    // Bypass rules are not encrypted and must survive.
    expect(reloaded.getSettings().httpProxyBypassRules).toBe(BYPASS_RULES)

    // Unrelated durable changes must not erase ciphertext that can recover later.
    reloaded.updateSettings({ httpProxyBypassRules: 'localhost' })
    vi.advanceTimersByTime(2000)
    await reloaded.waitForPendingWrite()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const persisted = JSON.parse(readPersistedStateJson(dataFile())) as {
      settings: { httpProxyUrl: string }
    }
    expect(persisted.settings.httpProxyUrl).toBe(originalCiphertext)
  })

  it('keeps a plaintext httpProxyUrl on disk readable (pre-encryption/hand-edited upgrade path)', async () => {
    mkdirSync(dirname(dataFile()), { recursive: true })
    writeFileSync(
      dataFile(),
      JSON.stringify({ settings: { httpProxyUrl: PROXY_URL, httpProxyBypassRules: BYPASS_RULES } }),
      'utf-8'
    )

    const store = await createStore()
    expect(store.getSettings().httpProxyUrl).toBe(PROXY_URL)
    expect(store.getSettings().httpProxyBypassRules).toBe(BYPASS_RULES)
  })

  it('saves non-secret proxy settings without plaintext when availability throws', async () => {
    cipherState.availabilityThrows = true

    const store = await createStore()
    store.updateSettings({ httpProxyUrl: PROXY_URL, httpProxyBypassRules: BYPASS_RULES })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()

    expect(existsSync(join(testState.dir, 'profile-state.db'))).toBe(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const persisted = JSON.parse(readPersistedStateJson(dataFile())) as {
      settings: { httpProxyUrl: string; httpProxyBypassRules: string }
    }
    expect(persisted.settings.httpProxyUrl).toBe('')
    expect(persisted.settings.httpProxyBypassRules).toBe(BYPASS_RULES)

    const reloaded = await createStore()
    expect(reloaded.getSettings().httpProxyUrl).toBe('')
    expect(reloaded.getSettings().httpProxyBypassRules).toBe(BYPASS_RULES)
  })
})

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SecretStore } from '../../shared/secret-store'
import { ForgeInboxLedger } from './forge-inbox-ledger'

export const WEBHOOK_TOKEN = 'whk-fake-token-31337'
export const INSTANCE_ID = 'gitlab-main'
export const PROJECT_ID = '42'

export function fakeSecretStore(key = randomBytes(32)): SecretStore {
  return {
    isEncryptionAvailable: () => true,
    describeProtectionGap: () => null,
    encryptString(plain) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decryptString(sealed) {
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12))
      decipher.setAuthTag(sealed.subarray(12, 28))
      return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString(
        'utf8'
      )
    }
  }
}

export function webhookInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: INSTANCE_ID,
    displayName: 'Main',
    baseUrl: 'https://gitlab.example.com',
    projects: [{ projectId: PROJECT_ID, repoId: 'repo-1', enabled: true }],
    ...overrides
  }
}

export function webhookConfig(
  instances: Record<string, unknown>[] = [webhookInstance()],
  listener: Record<string, unknown> = {}
) {
  return { schemaVersion: 1, listener, instances }
}

export type WebhookHarness = {
  dbPath: string
  store: SecretStore
  open: (options?: {
    webhookQueueLimits?: { maxPending: number; maxQueuedBytes: number }
    secretStore?: SecretStore
  }) => ForgeInboxLedger
  /** Applies a config plus the webhook credential and returns the resulting revision. */
  configure: (
    ledger: ForgeInboxLedger,
    config?: unknown,
    options?: { secret?: string | null }
  ) => number
  /** Moves the shared ledger clock forward so a backed-off delivery becomes claimable. */
  advanceClock: (ms: number) => void
  dispose: () => void
}

export function createWebhookHarness(): WebhookHarness {
  const root = mkdtempSync(join(tmpdir(), 'forge-webhook-'))
  const dbPath = join(root, 'forge-inbox.sqlite')
  const store = fakeSecretStore()
  const opened: ForgeInboxLedger[] = []
  let clock = 1_000
  return {
    dbPath,
    store,
    open(options = {}) {
      const ledger = ForgeInboxLedger.open(dbPath, {
        hostId: 'host-a',
        now: () => ++clock,
        secretStore: store,
        ...options
      })
      opened.push(ledger)
      return ledger
    },
    configure(ledger, config = webhookConfig(), options = {}) {
      const updated = ledger.updateConfig(ledger.getConfig().configRevision, config)
      if (!updated.ok) {
        throw new Error(`config rejected: ${updated.reason}`)
      }
      const secret = options.secret === undefined ? WEBHOOK_TOKEN : options.secret
      if (secret === null) {
        return updated.configRevision
      }
      const stored = ledger.setCredential({
        instanceId: INSTANCE_ID,
        kind: 'webhook',
        secret,
        expectedRevision: updated.configRevision
      })
      if (!stored.ok) {
        throw new Error(`credential rejected: ${stored.reason}`)
      }
      return stored.configRevision
    },
    advanceClock(ms) {
      clock += ms
    },
    dispose() {
      for (const ledger of opened) {
        try {
          ledger.close()
        } catch {
          // already closed by the test
        }
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
}

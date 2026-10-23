import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecretStore } from '../../shared/secret-store'
import Database from '../sqlite/sync-database'
import { ForgeInboxCorruptError, ForgeInboxHostMismatchError } from './forge-inbox-database'
import { ForgeInboxLedger } from './forge-inbox-ledger'

const TOKEN = 'glpat-Xk29vQ-TOP-SECRET-7731'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function fakeStore(overrides: Partial<SecretStore> = {}, key = randomBytes(32)): SecretStore {
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
    },
    ...overrides
  }
}

function instance(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gitlab-main',
    displayName: 'Main',
    baseUrl: 'https://gitlab.example.com',
    usernames: ['alice'],
    projects: [{ projectId: '42', repoId: 'repo-1', agentId: 'claude' }],
    ...overrides
  }
}

function config(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, instances: [instance()], ...overrides }
}

describe('forge inbox host configuration', () => {
  let root: string
  let dbPath: string
  let clock: number
  let ledger: ForgeInboxLedger
  let store: SecretStore
  const open = (hostId?: string) =>
    ForgeInboxLedger.open(dbPath, { hostId, now: () => ++clock, secretStore: store })
  const revision = () => ledger.getConfig().configRevision
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-inbox-config-'))
    dbPath = join(root, 'forge-inbox.sqlite')
    clock = 1000
    store = fakeStore()
    ledger = open()
  })

  afterEach(() => {
    ledger.close()
    rmSync(root, { recursive: true, force: true })
  })

  function configure(value: unknown = config()) {
    const result = ledger.updateConfig(revision(), value)
    expect(result).toMatchObject({ ok: true })
  }

  function pendingProposal() {
    const ingested = ledger.ingestEvent({
      hostId: ledger.hostId,
      instanceId: 'gitlab-main',
      projectId: '42',
      kind: 'merge_request',
      iid: 1,
      dedupeKey: 'd1',
      eventKind: 'merge_request.updated',
      payload: {},
      versionToken: 'v1',
      sourceOrder: 1,
      queueRun: { reason: 'x' }
    })
    const run = ledger.claimNextQueuedRun({ instanceId: 'gitlab-main' })
    if (ingested.duplicate || !run) {
      throw new Error('no run')
    }
    const made = ledger.createProposal({
      runId: run.id,
      expectedGeneration: run.generation,
      body: { comment: 'hi' }
    })
    if (!made.ok) {
      throw new Error(made.reason)
    }
    return made.proposal.id
  }

  describe('owner identity', () => {
    it('mints a stable random host id and refuses an explicit different one', () => {
      const first = ledger.hostId
      expect(first).toMatch(UUID)
      ledger.close()
      ledger = open()
      expect(ledger.hostId).toBe(first)
      ledger.close()
      expect(() => open('someone-else')).toThrow(ForgeInboxHostMismatchError)
      ledger = open(first)
      expect(ledger.hostId).toBe(first)
    })

    it('refuses a populated database whose owner was removed, leaving it untouched', () => {
      ledger.close()
      const raw = new Database(dbPath)
      raw.exec("DELETE FROM meta WHERE key = 'host_id'")
      raw.close()
      const before = digest(dbPath)
      expect(() => open()).toThrow(ForgeInboxCorruptError)
      expect(digest(dbPath)).toBe(before)
      rmSync(dbPath)
      ledger = open()
    })
  })

  describe('configuration', () => {
    it('starts disabled on loopback with no instances', () => {
      expect(ledger.getConfig()).toMatchObject({
        hostId: ledger.hostId,
        configRevision: 0,
        schemaVersion: 1,
        config: {
          listener: { enabled: false, bindAddress: '127.0.0.1' },
          instances: []
        },
        credentials: []
      })
    })

    it.each([
      [
        'external bind without acknowledgment',
        { listener: { enabled: true, bindAddress: '0.0.0.0' } }
      ],
      ['hostname bind', { listener: { bindAddress: 'localhost' } }],
      ['port zero', { listener: { port: 0 } }],
      ['port too large', { listener: { port: 65536 } }],
      ['unknown field', { autoMerge: true }],
      ['unknown version', { schemaVersion: 2 }],
      ['http without acknowledgment', { instances: [instance({ baseUrl: 'http://gitlab.lan' })] }],
      ['userinfo in URL', { instances: [instance({ baseUrl: 'https://u:p@gitlab.example.com' })] }],
      ['query in URL', { instances: [instance({ baseUrl: 'https://gitlab.example.com/?x=1' })] }],
      ['hash in URL', { instances: [instance({ baseUrl: 'https://gitlab.example.com/#x' })] }],
      ['non-http URL', { instances: [instance({ baseUrl: 'ftp://gitlab.example.com' })] }],
      ['unsafe instance id', { instances: [instance({ id: '../x' })] }],
      ['duplicate instance ids', { instances: [instance(), instance()] }],
      [
        'duplicate project ids',
        {
          instances: [
            instance({
              projects: [
                { projectId: '42', repoId: 'a', agentId: 'claude' },
                { projectId: '42', repoId: 'b', agentId: 'claude' }
              ]
            })
          ]
        }
      ],
      [
        'unsafe numeric project id',
        {
          instances: [
            instance({ projects: [{ projectId: '9007199254740993', repoId: 'a', agentId: 'x' }] })
          ]
        }
      ],
      [
        'project id with leading zero',
        { instances: [instance({ projects: [{ projectId: '042', repoId: 'a', agentId: 'x' }] })] }
      ],
      [
        'auto-write project option',
        {
          instances: [
            instance({
              projects: [{ projectId: '42', repoId: 'a', agentId: 'x', autoWrite: true }]
            })
          ]
        }
      ],
      [
        'automatic analysis without an agent',
        {
          instances: [
            instance({ projects: [{ projectId: '42', repoId: 'a', automaticAnalysis: true }] })
          ]
        }
      ],
      [
        'automatic analysis without a model',
        {
          instances: [
            instance({
              projects: [
                { projectId: '42', repoId: 'a', agentId: 'claude', automaticAnalysis: true }
              ]
            })
          ]
        }
      ],
      [
        'rules containing NUL',
        {
          instances: [instance({ projects: [{ projectId: '42', repoId: 'a', rules: 'a\u0000b' }] })]
        }
      ],
      [
        'oversized rules',
        {
          instances: [
            instance({
              projects: [{ projectId: '42', repoId: 'a', rules: '\u00e9'.repeat(8 * 1024 + 1) }]
            })
          ]
        }
      ],
      [
        'concurrency above one',
        {
          instances: [
            instance({
              projects: [{ projectId: '42', repoId: 'a', budgets: { maxConcurrentRuns: 2 } }]
            })
          ]
        }
      ],
      [
        'duplicate usernames ignoring case',
        { instances: [instance({ usernames: ['Alice', 'alice'] })] }
      ],
      [
        'oversized serialization',
        { instances: [instance({ displayName: 'x'.repeat(80), usernames: ['a'.repeat(250_000)] })] }
      ]
    ])('rejects %s with no mutation', (_name, patch) => {
      const merged = { ...config(), ...patch }
      const before = ledger.getConfig()
      expect(ledger.updateConfig(0, merged)).toMatchObject({ ok: false, reason: 'invalid-config' })
      expect(ledger.getConfig()).toEqual(before)
    })

    it('normalizes a self-managed base path and accepts acknowledged external and http', () => {
      configure(
        config({
          listener: {
            enabled: true,
            bindAddress: '10.0.0.5',
            port: 9000,
            acknowledgeExternalPlaintextHttp: true
          },
          instances: [
            instance({ baseUrl: 'HTTPS://GitLab.Example.com:443/corp/gitlab//' }),
            instance({
              id: 'lab',
              baseUrl: 'http://gitlab.lan:8080',
              allowInsecureHttpApi: true
            })
          ]
        })
      )
      const view = ledger.getConfig()
      expect(view.config.instances.map((i) => i.baseUrl)).toEqual([
        'https://gitlab.example.com/corp/gitlab',
        'http://gitlab.lan:8080'
      ])
      expect(view.config.instances[0].projects[0]).toMatchObject({
        enabled: false,
        events: { reviewRequests: false },
        budgets: { maxConcurrentRuns: 1 }
      })
    })

    it('lets a project monitor passively with no agent and analysis off', () => {
      configure(
        config({
          instances: [instance({ projects: [{ projectId: '42', repoId: 'a', enabled: true }] })]
        })
      )
      expect(ledger.getConfig().config.instances[0].projects[0]).toMatchObject({
        enabled: true,
        automaticAnalysis: false
      })
    })

    it('accepts opted-in analysis with agent and model and multiline rules', () => {
      configure(
        config({
          instances: [
            instance({
              projects: [
                {
                  projectId: '42',
                  repoId: 'a',
                  agentId: 'claude',
                  model: 'm1',
                  automaticAnalysis: true,
                  rules: 'Be brief.\n\tNo secrets.'
                }
              ]
            })
          ]
        })
      )
      expect(ledger.getConfig().config.instances[0].projects[0]).toMatchObject({
        automaticAnalysis: true,
        rules: 'Be brief.\n\tNo secrets.',
        budgets: { maxConcurrentRuns: 1 }
      })
    })

    it('hands out isolated views so mutating one never changes later reads', () => {
      const other = join(root, 'other.sqlite')
      const second = ForgeInboxLedger.open(other, { secretStore: store })
      const view = ledger.getConfig()
      view.config.instances.push({
        id: 'gitlab-main',
        displayName: 'Injected',
        baseUrl: 'https://gitlab.example.com',
        allowInsecureHttpApi: false,
        allowLegacyPayloadDigestDedupe: false,
        usernames: [],
        projects: []
      })
      view.config.listener.enabled = true
      expect(ledger.getConfig().config.instances).toEqual([])
      expect(ledger.getConfig().config.listener.enabled).toBe(false)
      expect(ledger.getConfig().configRevision).toBe(0)
      expect(
        ledger.setCredential({
          instanceId: 'gitlab-main',
          kind: 'webhook',
          secret: TOKEN,
          expectedRevision: 0
        })
      ).toMatchObject({ ok: false, reason: 'unknown-instance' })
      expect(second.getConfig().config.instances).toEqual([])
      second.close()

      configure()
      const stored = ledger.getConfig()
      stored.config.instances[0].displayName = 'Mutated'
      expect(ledger.getConfig().config.instances[0].displayName).toBe('Main')
    })

    it('blocks a stale revision and keeps the winner', () => {
      configure(config())
      expect(ledger.updateConfig(0, config({ instances: [] }))).toMatchObject({
        ok: false,
        reason: 'stale-revision',
        configRevision: 1
      })
      expect(ledger.getConfig().config.instances).toHaveLength(1)
    })

    it('keeps an instance bound to its first GitLab across remove and re-add', () => {
      configure()
      configure(config({ instances: [] }))
      const rebound = config({ instances: [instance({ baseUrl: 'https://evil.example.com' })] })
      expect(ledger.updateConfig(revision(), rebound)).toMatchObject({
        ok: false,
        reason: 'instance-origin-conflict',
        instanceId: 'gitlab-main'
      })
      expect(ledger.getConfig().config.instances).toEqual([])
      ledger.close()
      ledger = open()
      expect(ledger.updateConfig(revision(), rebound)).toMatchObject({ ok: false })
      configure(config({ instances: [instance({ displayName: 'Renamed' })] }))
      expect(ledger.getConfig().config.instances[0].displayName).toBe('Renamed')
    })

    it('revokes earlier proposals on success, persists after reopen, and not on failure', () => {
      configure()
      const id = pendingProposal()
      expect(ledger.updateConfig(0, config({ instances: [] }))).toMatchObject({ ok: false })
      expect(ledger.getProposal(id)?.status).toBe('pending')

      configure(config({ instances: [instance({ displayName: 'Again' })] }))
      expect(ledger.getProposal(id)?.status).toBe('stale')
      const generation = ledger.bumpPolicyGeneration({ instanceId: 'gitlab-main', projectId: '42' })
      expect(generation).toBe(3)
      ledger.close()
      ledger = open()
      expect(revision()).toBe(2)
      expect(ledger.getConfig().config.instances[0].displayName).toBe('Again')
      expect(ledger.getProposal(id)?.status).toBe('stale')
    })
  })

  describe('credentials', () => {
    const webhook = (extra: Record<string, unknown> = {}) => ({
      instanceId: 'gitlab-main',
      kind: 'webhook' as const,
      secret: TOKEN,
      expectedRevision: revision(),
      ...extra
    })

    beforeEach(() => configure())

    it('stores a sealed secret that never appears in the file or the public view', () => {
      expect(ledger.setCredential(webhook())).toMatchObject({ ok: true, protection: 'sealed' })
      const view = ledger.getConfig()
      expect(view.credentials).toEqual([
        { instanceId: 'gitlab-main', kind: 'webhook', protection: 'sealed', gap: null }
      ])
      expect(JSON.stringify(view)).not.toContain(TOKEN)
      expect(ledger.readSecret('gitlab-main', 'webhook')).toEqual({
        secret: TOKEN,
        protection: 'sealed',
        gap: null
      })
      ledger.close()
      for (const path of [dbPath, `${dbPath}-wal`].filter(existsSync)) {
        expect(readFileSync(path).includes(TOKEN)).toBe(false)
      }
      ledger = open()
      expect(ledger.readSecret('gitlab-main', 'webhook')?.secret).toBe(TOKEN)
    })

    it('keeps exact bytes of the secret', () => {
      const exact = 'a~B!{}|9'
      ledger.setCredential(webhook({ secret: exact }))
      expect(ledger.readSecret('gitlab-main', 'webhook')?.secret).toBe(exact)
    })

    it.each([
      ['empty', ''],
      ['newline', 'abc\ndef'],
      ['carriage return', 'abc\r'],
      ['NUL', 'abc\0'],
      ['space', 'abc def'],
      ['non-ASCII', 'tökén'],
      ['oversized', 'a'.repeat(8 * 1024 + 1)]
    ])('refuses a %s secret', (_name, secret) => {
      expect(ledger.setCredential(webhook({ secret }))).toMatchObject({
        ok: false,
        reason: 'invalid-secret'
      })
      expect(ledger.getConfig().credentials).toEqual([])
    })

    it('requires acknowledgment when encryption is unavailable and labels plaintext', () => {
      store = fakeStore({
        isEncryptionAvailable: () => false,
        describeProtectionGap: () => 'no keychain'
      })
      ledger.close()
      ledger = open()
      const before = revision()
      expect(ledger.setCredential(webhook())).toMatchObject({
        ok: false,
        reason: 'unprotected-storage',
        gap: 'no keychain'
      })
      expect(revision()).toBe(before)
      expect(ledger.getConfig().credentials).toEqual([])

      expect(ledger.setCredential(webhook({ allowUnprotectedStorage: true }))).toMatchObject({
        ok: true,
        protection: 'plaintext'
      })
      expect(ledger.getConfig().credentials[0]).toEqual({
        instanceId: 'gitlab-main',
        kind: 'webhook',
        protection: 'plaintext',
        gap: 'no keychain'
      })
      expect(ledger.readSecret('gitlab-main', 'webhook')?.protection).toBe('plaintext')
    })

    it('requires acknowledgment for a weak backend and still seals when allowed', () => {
      store = fakeStore({ describeProtectionGap: () => 'weak backend' })
      ledger.close()
      ledger = open()
      expect(ledger.setCredential(webhook())).toMatchObject({
        ok: false,
        reason: 'unprotected-storage'
      })
      expect(ledger.setCredential(webhook({ allowUnprotectedStorage: true }))).toMatchObject({
        ok: true,
        protection: 'sealed'
      })
      expect(ledger.getConfig().credentials[0]).toMatchObject({
        protection: 'sealed',
        gap: 'weak backend'
      })
    })

    it('keeps the old envelope and revision when sealing throws', () => {
      ledger.setCredential(webhook())
      const before = revision()
      store = fakeStore({
        encryptString: () => {
          throw new Error('keychain locked')
        }
      })
      ledger.close()
      ledger = open()
      expect(() =>
        ledger.setCredential(webhook({ secret: 'glpat-new', expectedRevision: before }))
      ).toThrow('keychain locked')
      expect(revision()).toBe(before)
      store = fakeStore()
    })

    it('reports an unreadable sealed secret instead of replacing it', () => {
      ledger.setCredential(webhook())
      const before = revision()
      store = fakeStore()
      ledger.close()
      ledger = open()
      expect(() => ledger.readSecret('gitlab-main', 'webhook')).toThrow()
      expect(revision()).toBe(before)
      expect(ledger.getConfig().credentials).toHaveLength(1)
    })

    it('revokes proposals and advances the revision on rotation and clear', () => {
      ledger.setCredential(webhook())
      const first = pendingProposal()
      const rotated = ledger.setCredential(webhook({ secret: 'glpat-rotated' }))
      expect(rotated).toMatchObject({ ok: true, configRevision: revision() })
      expect(ledger.getProposal(first)?.status).toBe('stale')
      expect(ledger.readSecret('gitlab-main', 'webhook')?.secret).toBe('glpat-rotated')

      const before = revision()
      expect(
        ledger.clearCredential({
          instanceId: 'gitlab-main',
          kind: 'webhook',
          expectedRevision: before
        })
      ).toMatchObject({ ok: true, configRevision: before + 1 })
      expect(ledger.readSecret('gitlab-main', 'webhook')).toBeNull()
      expect(ledger.getConfig().credentials).toEqual([])
    })

    it('denies stale revisions and unconfigured instances without changes', () => {
      const stale = revision()
      ledger.setCredential(webhook())
      expect(ledger.setCredential(webhook({ expectedRevision: stale }))).toMatchObject({
        ok: false,
        reason: 'stale-revision'
      })
      expect(
        ledger.clearCredential({
          instanceId: 'gitlab-main',
          kind: 'webhook',
          expectedRevision: stale
        })
      ).toMatchObject({ ok: false, reason: 'stale-revision' })
      expect(ledger.setCredential(webhook({ instanceId: 'nope' }))).toMatchObject({
        ok: false,
        reason: 'unknown-instance'
      })
      expect(ledger.readSecret('nope', 'webhook')).toBeNull()
      expect(ledger.getConfig().credentials).toHaveLength(1)
    })

    it('drops credentials of a removed instance so a re-add does not inherit them', () => {
      ledger.setCredential(webhook())
      configure(config({ instances: [] }))
      expect(ledger.readSecret('gitlab-main', 'webhook')).toBeNull()
      configure()
      expect(ledger.getConfig().credentials).toEqual([])
    })
  })
})

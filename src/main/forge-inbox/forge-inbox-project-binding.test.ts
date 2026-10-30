import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecretStore } from '../../shared/secret-store'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import {
  getProjectBinding,
  getProjectBindingByGitlab,
  listProjectBindings,
  removeProjectBinding,
  setProjectBindingProgress,
  upsertProjectBinding
} from './forge-inbox-project-binding'
import {
  ProjectBindingSecretUnavailableError,
  readProjectBindingSecret,
  setProjectBindingSecret
} from './forge-inbox-project-binding-secret'
import { isProjectEventBindingId } from '../../shared/forge-inbox-project-binding'

function fakeStore(overrides: Partial<SecretStore> = {}): SecretStore {
  return {
    isEncryptionAvailable: () => true,
    describeProtectionGap: () => null,
    encryptString(plain) {
      return Buffer.from(`sealed:${plain}`, 'utf8')
    },
    decryptString(cipher) {
      const text = cipher.toString('utf8')
      if (!text.startsWith('sealed:')) {
        throw new Error('bad ciphertext')
      }
      return text.slice('sealed:'.length)
    },
    ...overrides
  }
}

function binding(input: Partial<Parameters<typeof upsertProjectBinding>[1]> = {}) {
  return {
    bindingId: randomUUID(),
    projectPath: '/Users/me/orca',
    gitlabHost: 'gitlab.test:8929',
    gitlabPath: 'group/demo',
    gitlabProjectId: 3,
    callbackUrl: 'http://127.0.0.1:0/hook',
    ...input
  }
}

describe('project event binding store', () => {
  let root: string
  let dbPath: string
  let clock: number
  let store: SecretStore
  let ctx: ForgeLedgerContext

  const open = (hostId = 'host-1'): ForgeLedgerContext => {
    const opened = openForgeInboxDatabase(dbPath, hostId)
    return {
      db: opened.db,
      hostId: opened.hostId,
      now: () => ++clock,
      secretStore: () => store
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-binding-'))
    dbPath = join(root, 'forge-inbox.sqlite')
    clock = 1000
    store = fakeStore()
    ctx = open()
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('accepts a uuid binding id and rejects junk', () => {
    expect(isProjectEventBindingId(randomUUID())).toBe(true)
    expect(isProjectEventBindingId('not-a-uuid')).toBe(false)
    expect(isProjectEventBindingId('')).toBe(false)
  })

  it('round-trips a binding through upsert and get', () => {
    const input = binding()
    const view = upsertProjectBinding(ctx, input)
    expect(view.bindingId).toBe(input.bindingId)
    expect(view.projectPath).toBe(input.projectPath)
    expect(view.gitlabHost).toBe(input.gitlabHost)
    expect(view.gitlabPath).toBe(input.gitlabPath)
    expect(view.gitlabProjectId).toBe(input.gitlabProjectId)
    expect(view.callbackUrl).toBe(input.callbackUrl)
    expect(view.state).toBe('unconfigured')
    expect(view.hookId).toBeNull()
    expect(view.failure).toBeNull()
    expect(view.secretProtection).toBeNull()
    expect(view.createdAt).toBeGreaterThan(0)
    expect(getProjectBinding(ctx, input.bindingId)).toEqual(view)
  })

  it('keeps the stored project path when the same binding is upserted from a worktree', () => {
    const input = binding()
    upsertProjectBinding(ctx, input)
    upsertProjectBinding(ctx, { ...input, projectPath: '/Users/me/orca-worktree' })
    expect(getProjectBinding(ctx, input.bindingId)?.projectPath).toBe(input.projectPath)
  })

  it('persists a binding across a ledger reopen', () => {
    const input = binding()
    upsertProjectBinding(ctx, input)
    ctx.db.close()

    ctx = open('host-1')
    const view = getProjectBinding(ctx, input.bindingId)
    expect(view?.gitlabPath).toBe(input.gitlabPath)
    expect(view?.state).toBe('unconfigured')
  })

  it('finds a binding by gitlab host and project id', () => {
    const input = binding()
    upsertProjectBinding(ctx, input)
    const view = getProjectBindingByGitlab(ctx, input.gitlabHost, input.gitlabProjectId)
    expect(view?.bindingId).toBe(input.bindingId)
    expect(getProjectBindingByGitlab(ctx, 'other-host', 3)).toBeNull()
    expect(getProjectBindingByGitlab(ctx, input.gitlabHost, 99)).toBeNull()
  })

  it('enforces one binding per gitlab host and project', () => {
    upsertProjectBinding(ctx, binding())
    expect(() =>
      upsertProjectBinding(ctx, binding({ bindingId: randomUUID(), gitlabProjectId: 3 }))
    ).toThrow()
  })

  it('refreshes identity on a repeated upsert of the same binding', () => {
    const input = binding()
    upsertProjectBinding(ctx, input)
    upsertProjectBinding(ctx, {
      ...input,
      gitlabPath: 'group/renamed',
      callbackUrl: 'http://x/hook'
    })
    const view = getProjectBinding(ctx, input.bindingId)
    expect(view?.gitlabPath).toBe('group/renamed')
    expect(view?.callbackUrl).toBe('http://x/hook')
    expect(listProjectBindings(ctx)).toHaveLength(1)
  })

  it('lists bindings and removes them', () => {
    const first = upsertProjectBinding(ctx, binding({ gitlabProjectId: 1 }))
    const second = upsertProjectBinding(ctx, binding({ gitlabProjectId: 2 }))
    expect(listProjectBindings(ctx).map((b) => b.bindingId)).toEqual([
      first.bindingId,
      second.bindingId
    ])
    expect(removeProjectBinding(ctx, first.bindingId)).toBe(true)
    expect(getProjectBinding(ctx, first.bindingId)).toBeNull()
    expect(removeProjectBinding(ctx, first.bindingId)).toBe(false)
  })

  it('advances state through checking and registering to connected with a hook id', () => {
    const input = binding()
    upsertProjectBinding(ctx, input)

    setProjectBindingProgress(ctx, input.bindingId, { state: 'checking' })
    setProjectBindingProgress(ctx, input.bindingId, { state: 'registering', hookId: 42 })
    const connected = setProjectBindingProgress(ctx, input.bindingId, { state: 'connected' })

    expect(connected.state).toBe('connected')
    expect(connected.hookId).toBe(42)
    expect(connected.failure).toBeNull()
  })

  it('requires a failure when entering the failed state', () => {
    const input = binding()
    upsertProjectBinding(ctx, input)
    expect(() => setProjectBindingProgress(ctx, input.bindingId, { state: 'failed' })).toThrow()
  })

  it('stores a failure with phase, code and retryability then clears it', () => {
    const input = binding()
    upsertProjectBinding(ctx, input)

    const failed = setProjectBindingProgress(ctx, input.bindingId, {
      state: 'failed',
      failure: { phase: 'registering', code: 'glab-unavailable', retryable: true }
    })
    expect(failed.failure).toEqual({
      phase: 'registering',
      code: 'glab-unavailable',
      failedAt: expect.any(Number),
      retryable: true
    })

    const cleared = setProjectBindingProgress(ctx, input.bindingId, { state: 'checking' })
    expect(cleared.failure).toBeNull()
    expect(cleared.state).toBe('checking')
  })

  it('seals and reveals a per-binding secret without leaking it in the view', () => {
    const input = binding()
    upsertProjectBinding(ctx, input)

    const result = setProjectBindingSecret(ctx, {
      bindingId: input.bindingId,
      secret: 'correct-horse-battery-staple'
    })
    expect(result).toEqual({ ok: true, protection: 'sealed' })

    const view = getProjectBinding(ctx, input.bindingId)
    expect(view?.secretProtection).toBe('sealed')
    expect('secret' in (view ?? {})).toBe(false)
    expect(JSON.stringify(view)).not.toContain('correct-horse-battery-staple')

    expect(readProjectBindingSecret(ctx, input.bindingId)).toEqual({
      secret: 'correct-horse-battery-staple',
      protection: 'sealed',
      gap: null
    })
  })

  it('refuses to store plaintext when the host cannot seal and it is not allowed', () => {
    store = fakeStore({
      isEncryptionAvailable: () => false,
      describeProtectionGap: () => 'no keychain on this host'
    })
    const input = binding()
    upsertProjectBinding(ctx, input)

    const result = setProjectBindingSecret(ctx, {
      bindingId: input.bindingId,
      secret: 'correct-horse-battery-staple'
    })
    expect(result).toEqual({
      ok: false,
      reason: 'unprotected-storage',
      gap: 'no keychain on this host'
    })
    expect(readProjectBindingSecret(ctx, input.bindingId)).toBeNull()
  })

  it('stores plaintext when explicitly allowed on an unsealable host', () => {
    store = fakeStore({
      isEncryptionAvailable: () => false,
      describeProtectionGap: () => 'no keychain on this host'
    })
    const input = binding()
    upsertProjectBinding(ctx, input)

    const result = setProjectBindingSecret(ctx, {
      bindingId: input.bindingId,
      secret: 'correct-horse-battery-staple',
      allowUnprotectedStorage: true
    })
    expect(result).toEqual({ ok: true, protection: 'plaintext' })
    expect(readProjectBindingSecret(ctx, input.bindingId)).toEqual({
      secret: 'correct-horse-battery-staple',
      protection: 'plaintext',
      gap: 'no keychain on this host'
    })
  })

  it('rejects a secret that is not bounded printable ascii', () => {
    const input = binding()
    upsertProjectBinding(ctx, input)
    const bad = setProjectBindingSecret(ctx, { bindingId: input.bindingId, secret: 'with space' })
    expect(bad).toEqual({ ok: false, reason: 'invalid-secret' })
    const oversized = setProjectBindingSecret(ctx, {
      bindingId: input.bindingId,
      secret: 'x'.repeat(9 * 1024)
    })
    expect(oversized).toEqual({ ok: false, reason: 'invalid-secret' })
  })

  it('reports an unknown binding for a secret write and null for a missing secret read', () => {
    const unknown = setProjectBindingSecret(ctx, {
      bindingId: randomUUID(),
      secret: 'correct-horse-battery-staple'
    })
    expect(unknown).toEqual({ ok: false, reason: 'unknown-binding' })

    const input = binding()
    upsertProjectBinding(ctx, input)
    expect(readProjectBindingSecret(ctx, input.bindingId)).toBeNull()
  })

  it('treats a corrupted sealed envelope as unavailable rather than returning garbage', () => {
    const input = binding()
    upsertProjectBinding(ctx, input)
    setProjectBindingSecret(ctx, {
      bindingId: input.bindingId,
      secret: 'correct-horse-battery-staple'
    })

    // Corrupt the envelope by writing an unrelated plaintext blob in place.
    ctx.db
      .prepare('UPDATE project_bindings SET secret_envelope = ? WHERE binding_id = ?')
      .run(Buffer.from('not-our-payload'), input.bindingId)
    expect(() => readProjectBindingSecret(ctx, input.bindingId)).toThrow(
      ProjectBindingSecretUnavailableError
    )
  })
})

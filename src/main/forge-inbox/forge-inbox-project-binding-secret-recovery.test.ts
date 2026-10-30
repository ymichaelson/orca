import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecretStore } from '../../shared/secret-store'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { getProjectBinding } from './forge-inbox-project-binding'
import { ensureProjectBinding } from './forge-inbox-project-binding-reconcile'
import { rotateProjectBindingSecret } from './forge-inbox-project-binding-rotation'
import {
  ProjectBindingSecretUnavailableError,
  readProjectBindingPendingSecret,
  readProjectBindingSecret
} from './forge-inbox-project-binding-secret'
import {
  fakeGitlab,
  fakeStore,
  http,
  receiverBaseUrl
} from './forge-inbox-project-binding-test-fixture'
import { authorizeProjectEventBinding } from './forge-inbox-project-event-binding-auth'

describe('unavailable staged binding secret recovery', () => {
  let root: string
  let store: SecretStore
  let ctx: ForgeLedgerContext

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-staged-secret-recovery-'))
    const opened = openForgeInboxDatabase(join(root, 'inbox.sqlite'), 'host-1')
    store = fakeStore()
    let clock = 1000
    ctx = { ...opened, now: () => ++clock, secretStore: () => store }
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  const ensure = (gitlab: ReturnType<typeof fakeGitlab>) =>
    ensureProjectBinding(ctx, {
      repoId: 'repo-a',
      repoPath: '/clone-a',
      explicitProjectRef: { host: gitlab.host, path: 'group/demo' },
      receiverBaseUrl,
      exec: gitlab.exec,
      probe: async () => ({ ok: true })
    })

  function pendingEnvelope(bindingId: string): Buffer | null {
    const bytes = ctx.db
      .prepare('SELECT pending_secret_envelope FROM project_bindings WHERE binding_id = ?')
      .get(bindingId)?.pending_secret_envelope
    return bytes instanceof Uint8Array ? Buffer.from(bytes) : null
  }

  async function lostRotation() {
    const gitlab = fakeGitlab()
    const connected = await ensure(gitlab)
    if (!connected.ok) {
      throw new Error('fixture did not connect')
    }
    const bindingId = connected.binding.bindingId
    const active = readProjectBindingSecret(ctx, bindingId)?.secret
    const rotated = await rotateProjectBindingSecret(ctx, {
      bindingId,
      repoPath: '/clone-a',
      exec: async (args, options) => {
        const response = await gitlab.exec(args, options)
        if (args.includes('PUT')) {
          throw new Error('rotation response lost')
        }
        return response
      }
    })
    expect(rotated).toMatchObject({ ok: false, code: 'unknown-outcome' })
    const pending = pendingEnvelope(bindingId)
    if (pending === null) {
      throw new Error('fixture did not retain the pending envelope')
    }
    const candidate = readProjectBindingPendingSecret(ctx, bindingId)
    expect(candidate === gitlab.hooks[0].token).toBe(true)
    expect(candidate !== active).toBe(true)
    return { gitlab, bindingId, active, pending, candidate }
  }

  it.each(['encryption-unavailable', 'decrypt-failed', 'store-unavailable'] as const)(
    'does not erase pending intent when a getter encounters %s',
    async (failure) => {
      const { gitlab, bindingId, pending, candidate } = await lostRotation()
      const writes = gitlab.created.length
      if (failure === 'store-unavailable') {
        ctx.secretStore = () => {
          throw new Error('secret store temporarily unavailable')
        }
      } else {
        store = fakeStore(
          failure === 'encryption-unavailable'
            ? { isEncryptionAvailable: () => false }
            : {
                decryptString: () => {
                  throw new Error('decryption temporarily unavailable')
                }
              }
        )
      }

      expect(() => readProjectBindingPendingSecret(ctx, bindingId)).toThrow(
        ProjectBindingSecretUnavailableError
      )
      expect(pendingEnvelope(bindingId)?.equals(pending)).toBe(true)
      expect(getProjectBinding(ctx, bindingId)?.rotationPending).toBe(true)
      expect(gitlab.created.length).toBe(writes)

      store = fakeStore()
      ctx.secretStore = () => store
      expect(readProjectBindingPendingSecret(ctx, bindingId) === candidate).toBe(true)
    }
  )

  it('keeps an earlier permission failure visible while the retained secret is unreadable', async () => {
    const { gitlab, bindingId, pending, candidate } = await lostRotation()
    const denied = await ensureProjectBinding(ctx, {
      repoId: 'repo-a',
      repoPath: '/clone-a',
      explicitProjectRef: { host: gitlab.host, path: 'group/demo' },
      receiverBaseUrl,
      exec: async (args, options) =>
        args.some((arg) => arg.endsWith('hooks?per_page=1'))
          ? { stdout: http(403, { message: 'denied' }), stderr: '' }
          : gitlab.exec(args, options),
      probe: async () => ({ ok: true })
    })
    expect(denied).toMatchObject({ ok: false, code: 'no-hook-permission' })
    const workingStore = fakeStore()
    store = fakeStore({
      decryptString: (cipher) => {
        if (cipher.equals(pending)) {
          throw new Error('pending secret temporarily unavailable')
        }
        return workingStore.decryptString(cipher)
      }
    })
    const rotate = () =>
      rotateProjectBindingSecret(ctx, {
        bindingId,
        repoPath: '/clone-a',
        exec: gitlab.exec
      })

    const unavailable = await rotate()

    expect(unavailable).toMatchObject({ ok: false, code: 'secret-unavailable', retryable: true })
    expect(getProjectBinding(ctx, bindingId)).toMatchObject({
      state: 'failed',
      failure: { phase: 'checking', code: 'no-hook-permission' },
      rotationPending: true
    })

    store = workingStore
    const recovered = await rotate()

    expect(recovered.ok).toBe(true)
    expect(getProjectBinding(ctx, bindingId)).toMatchObject({
      state: 'failed',
      failure: { phase: 'checking', code: 'no-hook-permission' },
      rotationPending: false
    })
    expect(readProjectBindingSecret(ctx, bindingId)?.secret === candidate).toBe(true)
  })

  it.each(['rotate', 'reconcile'] as const)(
    'reports a visible unavailable secret during %s when the entire store is unavailable',
    async (operation) => {
      const { gitlab, bindingId, pending, candidate } = await lostRotation()
      const writes = gitlab.created.length
      ctx.secretStore = () => {
        throw new Error('secret store temporarily unavailable')
      }

      const result =
        operation === 'rotate'
          ? await rotateProjectBindingSecret(ctx, {
              bindingId,
              repoPath: '/clone-a',
              exec: gitlab.exec
            })
          : await ensure(gitlab)

      expect(result).toMatchObject({
        ok: false,
        code: 'secret-unavailable',
        retryable: true,
        binding: {
          failure: { code: 'secret-unavailable' },
          rotationPending: true
        }
      })
      expect(pendingEnvelope(bindingId)?.equals(pending)).toBe(true)
      expect(gitlab.created.length).toBe(writes)
      ctx.secretStore = () => store
      expect(readProjectBindingPendingSecret(ctx, bindingId) === candidate).toBe(true)
    }
  )

  it.each(['rotate', 'reconcile'] as const)(
    'reports a visible unavailable secret during %s and retries the exact retained candidate',
    async (operation) => {
      const { gitlab, bindingId, active, pending, candidate } = await lostRotation()
      const writes = gitlab.created.length
      const workingStore = fakeStore()
      store = fakeStore({
        decryptString: (cipher) => {
          if (cipher.equals(pending)) {
            throw new Error('pending secret temporarily unavailable')
          }
          return workingStore.decryptString(cipher)
        }
      })
      const retry = () =>
        operation === 'rotate'
          ? rotateProjectBindingSecret(ctx, {
              bindingId,
              repoPath: '/clone-a',
              exec: gitlab.exec
            })
          : ensure(gitlab)

      const unavailable = await retry()

      expect(unavailable).toMatchObject({
        ok: false,
        code: 'secret-unavailable',
        binding: {
          state: 'failed',
          failure: { phase: 'registering', code: 'secret-unavailable' },
          rotationPending: true
        }
      })
      expect(pendingEnvelope(bindingId)?.equals(pending)).toBe(true)
      expect(readProjectBindingSecret(ctx, bindingId)?.secret === active).toBe(true)
      expect(gitlab.created.length).toBe(writes)
      expect(gitlab.hooks[0].token === candidate).toBe(true)

      store = workingStore
      const recovered = await retry()

      expect(recovered.ok).toBe(true)
      expect(gitlab.created.length).toBe(writes + 1)
      if (operation === 'rotate') {
        expect(getProjectBinding(ctx, bindingId)?.state).toBe('failed')
        expect((await ensure(gitlab)).ok).toBe(true)
      }
      expect(getProjectBinding(ctx, bindingId)).toMatchObject({
        state: 'connected',
        failure: null,
        rotationPending: false
      })
      expect(
        authorizeProjectEventBinding(ctx, { bindingId, token: candidate ?? '' })
      ).toMatchObject({ ok: true })
      expect(readProjectBindingSecret(ctx, bindingId)?.secret === candidate).toBe(true)
      expect(getProjectBinding(ctx, bindingId)?.rotationPending).toBe(false)
      expect(gitlab.hooks).toHaveLength(1)
      expect(gitlab.hooks[0].token === candidate).toBe(true)
      expect(gitlab.created.slice(1).every((entry) => entry.body.token === candidate)).toBe(true)
    }
  )
})

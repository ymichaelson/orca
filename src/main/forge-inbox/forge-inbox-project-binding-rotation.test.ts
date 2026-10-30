import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecretStore } from '../../shared/secret-store'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { getProjectBinding, upsertProjectBinding } from './forge-inbox-project-binding'
import { ensureProjectBinding } from './forge-inbox-project-binding-reconcile'
import { rotateProjectBindingSecret } from './forge-inbox-project-binding-rotation'
import {
  readProjectBindingPendingSecret,
  readProjectBindingSecret,
  stageProjectBindingSecretRotation
} from './forge-inbox-project-binding-secret'
import { authorizeProjectEventBinding } from './forge-inbox-project-event-binding-auth'
import {
  fakeGitlab,
  fakeStore,
  http,
  receiverBaseUrl,
  type Exec
} from './forge-inbox-project-binding-test-fixture'

describe('project event binding secret rotation', () => {
  let root: string
  let dbPath: string
  let clock: number
  let store: SecretStore
  let ctx: ForgeLedgerContext

  const open = (): ForgeLedgerContext => {
    const opened = openForgeInboxDatabase(dbPath, 'host-1')
    return {
      db: opened.db,
      hostId: opened.hostId,
      now: () => ++clock,
      secretStore: () => store
    }
  }

  const ensure = (
    gitlab: ReturnType<typeof fakeGitlab>,
    exec: Exec = gitlab.exec,
    probe: () => Promise<{ ok: boolean }> = async () => ({ ok: true })
  ) =>
    ensureProjectBinding(ctx, {
      repoPath: '/repo',
      explicitProjectRef: { host: gitlab.host, path: 'group/demo' },
      receiverBaseUrl,
      exec,
      probe
    })

  const rotate = (bindingId: string, exec: Exec) =>
    rotateProjectBindingSecret(ctx, { bindingId, repoPath: '/repo', exec })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-rotation-'))
    dbPath = join(root, 'forge-inbox.sqlite')
    clock = 1000
    store = fakeStore()
    ctx = open()
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('leaves the old secret as the only active secret when the remote write fails', async () => {
    let bindingId = ''
    const observed: { pendingDuringWrite?: boolean } = {}
    const gitlab = fakeGitlab({
      onHookWrite: () => {
        observed.pendingDuringWrite = getProjectBinding(ctx, bindingId)?.rotationPending
      }
    })
    const ensured = await ensure(gitlab)
    expect(ensured.ok).toBe(true)
    if (!ensured.ok) {
      return
    }
    bindingId = ensured.binding.bindingId
    const oldSecret = readProjectBindingSecret(ctx, bindingId)?.secret
    expect(oldSecret).toBeTruthy()
    expect(gitlab.hooks[0].token).toBe(oldSecret)

    gitlab.setWriteStatus(403)
    const rotated = await rotateProjectBindingSecret(ctx, {
      bindingId,
      repoPath: '/repo',
      exec: gitlab.exec
    })

    expect(rotated.ok).toBe(false)
    if (rotated.ok) {
      return
    }
    expect(rotated.code).toBe('forbidden')
    expect(rotated.retryable).toBe(true)
    // Pending state must exist before the remote call so a failure can clear it, never keep two.
    expect(observed.pendingDuringWrite).toBe(true)
    expect(getProjectBinding(ctx, bindingId)?.rotationPending).toBe(false)
    expect(readProjectBindingSecret(ctx, bindingId)?.secret).toBe(oldSecret)
    expect(gitlab.hooks[0].token).toBe(oldSecret)
  })

  it('promotes the new secret only after the remote hook accepts it', async () => {
    const gitlab = fakeGitlab()
    const ensured = await ensure(gitlab)
    expect(ensured.ok).toBe(true)
    if (!ensured.ok) {
      return
    }
    const bindingId = ensured.binding.bindingId
    const oldSecret = readProjectBindingSecret(ctx, bindingId)?.secret

    const rotated = await rotateProjectBindingSecret(ctx, {
      bindingId,
      repoPath: '/repo',
      exec: gitlab.exec
    })

    expect(rotated.ok).toBe(true)
    if (!rotated.ok) {
      return
    }
    const newSecret = readProjectBindingSecret(ctx, bindingId)?.secret
    expect(newSecret).toBeTruthy()
    expect(newSecret).not.toBe(oldSecret)
    expect(gitlab.hooks[0].token).toBe(newSecret)
    expect(rotated.binding.rotationPending).toBe(false)
    expect(getProjectBinding(ctx, bindingId)?.rotationPending).toBe(false)
  })

  it('reconciles a staged secret left by a crash by applying and promoting that same secret', async () => {
    const gitlab = fakeGitlab()
    const ensured = await ensure(gitlab)
    expect(ensured.ok).toBe(true)
    if (!ensured.ok) {
      return
    }
    const bindingId = ensured.binding.bindingId
    const staged = stageProjectBindingSecretRotation(ctx, {
      bindingId,
      secret: 'staged-before-restart'
    })
    expect(staged.ok).toBe(true)
    ctx.db.close()

    ctx = open()
    expect(getProjectBinding(ctx, bindingId)?.rotationPending).toBe(true)
    const recovered = await ensure(gitlab)

    expect(recovered.ok).toBe(true)
    expect(getProjectBinding(ctx, bindingId)?.rotationPending).toBe(false)
    expect(readProjectBindingSecret(ctx, bindingId)?.secret).toBe('staged-before-restart')
    expect(gitlab.hooks).toHaveLength(1)
    expect(gitlab.hooks[0].token).toBe('staged-before-restart')
  })

  it('does not overwrite a secret that is already staged', async () => {
    const ensured = await ensure(fakeGitlab())
    if (!ensured.ok) {
      throw new Error('fixture binding did not connect')
    }
    const bindingId = ensured.binding.bindingId
    expect(stageProjectBindingSecretRotation(ctx, { bindingId, secret: 'first-staged' }).ok).toBe(
      true
    )

    const second = stageProjectBindingSecretRotation(ctx, { bindingId, secret: 'second-staged' })

    expect(second).toEqual({ ok: false, reason: 'already-staged' })
    expect(readProjectBindingPendingSecret(ctx, bindingId)).toBe('first-staged')
  })

  describe('when the remote write applies but its response is lost', () => {
    async function rotateWithLostResponse() {
      const gitlab = fakeGitlab()
      const ensured = await ensure(gitlab)
      if (!ensured.ok) {
        throw new Error('fixture binding did not connect')
      }
      const bindingId = ensured.binding.bindingId
      const oldSecret = readProjectBindingSecret(ctx, bindingId)?.secret
      let dropped = false
      const rotated = await rotateProjectBindingSecret(ctx, {
        bindingId,
        repoPath: '/repo',
        exec: async (args, options) => {
          const response = await gitlab.exec(args, options)
          if (!dropped && args.includes('PUT')) {
            dropped = true
            throw new Error('response lost')
          }
          return response
        }
      })
      const appliedToken = gitlab.hooks[0].token
      if (typeof appliedToken !== 'string') {
        throw new Error('fixture hook did not record the applied token')
      }
      return { gitlab, bindingId, oldSecret, rotated, appliedToken }
    }

    it('keeps the staged secret and reports an uncertain failed binding', async () => {
      const { bindingId, oldSecret, rotated, appliedToken } = await rotateWithLostResponse()

      expect(rotated).toMatchObject({ ok: false, code: 'unknown-outcome', retryable: true })
      expect(appliedToken).not.toBe(oldSecret)
      expect(getProjectBinding(ctx, bindingId)).toMatchObject({
        state: 'failed',
        failure: { phase: 'registering', code: 'unknown-outcome', retryable: true },
        rotationPending: true
      })
      expect(readProjectBindingSecret(ctx, bindingId)?.secret).toBe(oldSecret)
    })

    it('reuses the staged secret on a rotate retry instead of generating a third one', async () => {
      const { gitlab, bindingId, rotated, appliedToken } = await rotateWithLostResponse()
      expect(rotated.ok).toBe(false)

      const retried = await rotateProjectBindingSecret(ctx, {
        bindingId,
        repoPath: '/repo',
        exec: gitlab.exec
      })

      expect(retried.ok).toBe(true)
      expect(gitlab.created.map((entry) => entry.body.token)).toEqual([
        expect.any(String),
        appliedToken,
        appliedToken
      ])
      expect(readProjectBindingSecret(ctx, bindingId)?.secret).toBe(appliedToken)
      expect(getProjectBinding(ctx, bindingId)?.rotationPending).toBe(false)
    })

    it('reconciles the same staged secret through revalidation after a restart', async () => {
      const { gitlab, bindingId, appliedToken } = await rotateWithLostResponse()
      ctx.db.close()
      ctx = open()

      const recovered = await ensure(gitlab)

      expect(recovered.ok).toBe(true)
      expect(gitlab.hooks).toHaveLength(1)
      expect(gitlab.hooks[0].token).toBe(appliedToken)
      expect(readProjectBindingSecret(ctx, bindingId)?.secret).toBe(appliedToken)
      expect(getProjectBinding(ctx, bindingId)).toMatchObject({
        state: 'connected',
        rotationPending: false
      })
    })

    it('requires callback revalidation before admitting the promoted secret after a rotate retry', async () => {
      const { gitlab, bindingId, appliedToken } = await rotateWithLostResponse()

      const retried = await rotate(bindingId, gitlab.exec)

      expect(retried.ok).toBe(true)
      expect(getProjectBinding(ctx, bindingId)?.state).toBe('failed')
      expect(authorizeProjectEventBinding(ctx, { bindingId, token: appliedToken }).ok).toBe(false)
      expect((await ensure(gitlab)).ok).toBe(true)
      expect(getProjectBinding(ctx, bindingId)).toMatchObject({
        state: 'connected',
        failure: null,
        rotationPending: false
      })
      expect(authorizeProjectEventBinding(ctx, { bindingId, token: appliedToken })).toMatchObject({
        ok: true
      })
    })

    it.each([
      ['network', 'hooks-list-fails'],
      ['callback-blocked', 'write-blocked']
    ] as const)(
      'leaves a reconcile failure with %s failed after the retained secret is applied',
      async (code, failure) => {
        const { gitlab, bindingId, appliedToken } = await rotateWithLostResponse()
        const failed = await ensure(gitlab, async (args, options) => {
          if (failure === 'hooks-list-fails' && args.some((arg) => arg.includes('per_page=100'))) {
            throw new Error('network down')
          }
          if (failure === 'write-blocked' && args.includes('PUT')) {
            throw Object.assign(new Error('rejected'), { stderr: 'URL is blocked' })
          }
          return gitlab.exec(args, options)
        })
        expect(failed).toMatchObject({ ok: false, code })
        expect(getProjectBinding(ctx, bindingId)).toMatchObject({
          state: 'failed',
          failure: { phase: 'registering', code },
          rotationPending: true
        })

        const rotated = await rotate(bindingId, gitlab.exec)

        expect(rotated.ok).toBe(true)
        expect(getProjectBinding(ctx, bindingId)).toMatchObject({
          state: 'failed',
          failure: { phase: 'registering', code },
          rotationPending: false
        })
        expect(readProjectBindingSecret(ctx, bindingId)?.secret).toBe(appliedToken)
      }
    )

    describe.each(['rotate', 'reconcile'] as const)('a later %s that does not apply it', (kind) => {
      const retry = (gitlab: ReturnType<typeof fakeGitlab>, bindingId: string, exec: Exec) =>
        kind === 'rotate' ? rotate(bindingId, exec) : ensure(gitlab, exec)

      it.each(['hooks-list-fails', 'write-rejected'] as const)(
        'keeps the earlier unknown-outcome secret when the hooks %s',
        async (failure) => {
          const { gitlab, bindingId, oldSecret, appliedToken } = await rotateWithLostResponse()
          const pendingBefore = readProjectBindingPendingSecret(ctx, bindingId)
          expect(pendingBefore).toBe(appliedToken)
          const writes = gitlab.created.length
          if (failure === 'write-rejected') {
            gitlab.setWriteStatus(403)
          }

          const failed = await retry(gitlab, bindingId, async (args, options) => {
            if (
              failure === 'hooks-list-fails' &&
              args.some((arg) => arg.includes('per_page=100'))
            ) {
              throw new Error('network down')
            }
            return gitlab.exec(args, options)
          })

          expect(failed.ok).toBe(false)
          expect(readProjectBindingPendingSecret(ctx, bindingId)).toBe(appliedToken)
          expect(getProjectBinding(ctx, bindingId)?.rotationPending).toBe(true)
          expect(readProjectBindingSecret(ctx, bindingId)?.secret).toBe(oldSecret)
          expect(gitlab.hooks[0].token).toBe(appliedToken)
          expect(gitlab.created.length).toBe(writes)

          gitlab.setWriteStatus(null)
          const recovered = await retry(gitlab, bindingId, gitlab.exec)

          expect(recovered.ok).toBe(true)
          expect(gitlab.hooks).toHaveLength(1)
          expect(gitlab.hooks[0].token).toBe(appliedToken)
          expect(gitlab.created.slice(1).every((entry) => entry.body.token === appliedToken)).toBe(
            true
          )
          expect(readProjectBindingSecret(ctx, bindingId)?.secret).toBe(appliedToken)
          if (kind === 'rotate') {
            expect(getProjectBinding(ctx, bindingId)?.state).toBe('failed')
            expect((await ensure(gitlab)).ok).toBe(true)
          }
          expect(getProjectBinding(ctx, bindingId)).toMatchObject({
            state: 'connected',
            rotationPending: false
          })
        }
      )
    })
  })

  describe('when the first registration lost its response', () => {
    async function lostFirstRegistration() {
      const gitlab = fakeGitlab()
      const failed = await ensure(gitlab, async (args, options) => {
        const response = await gitlab.exec(args, options)
        if (args.includes('POST')) {
          throw new Error('response lost')
        }
        return response
      })
      if (failed.ok || failed.binding === null) {
        throw new Error('fixture first registration did not fail uncertainly')
      }
      const bindingId = failed.binding.bindingId
      expect(getProjectBinding(ctx, bindingId)).toMatchObject({
        state: 'failed',
        failure: { phase: 'registering', code: 'unknown-outcome' },
        hookId: null
      })
      return { gitlab, bindingId }
    }

    it('stays failed after a fresh-candidate rotation until a reconcile probes the callback', async () => {
      const { gitlab, bindingId } = await lostFirstRegistration()

      const rotated = await rotate(bindingId, gitlab.exec)

      expect(rotated.ok).toBe(true)
      expect(getProjectBinding(ctx, bindingId)).toMatchObject({
        state: 'failed',
        failure: { phase: 'registering', code: 'unknown-outcome' },
        rotationPending: false
      })
      let probes = 0
      const reconciled = await ensure(gitlab, gitlab.exec, async () => {
        probes += 1
        return { ok: true }
      })
      expect(reconciled.ok).toBe(true)
      expect(probes).toBe(1)
      expect(getProjectBinding(ctx, bindingId)?.state).toBe('connected')
    })

    it('stays failed after a retained-candidate rotation too', async () => {
      const { gitlab, bindingId } = await lostFirstRegistration()
      let dropped = false
      const lost = await rotate(bindingId, async (args, options) => {
        const response = await gitlab.exec(args, options)
        if (!dropped && args.includes('PUT')) {
          dropped = true
          throw new Error('response lost')
        }
        return response
      })
      expect(lost).toMatchObject({ ok: false, code: 'unknown-outcome' })
      expect(getProjectBinding(ctx, bindingId)?.rotationPending).toBe(true)

      const rotated = await rotate(bindingId, gitlab.exec)

      expect(rotated.ok).toBe(true)
      expect(getProjectBinding(ctx, bindingId)).toMatchObject({
        state: 'failed',
        failure: { phase: 'registering', code: 'unknown-outcome' },
        rotationPending: false
      })
    })
  })

  it('does not mistake a failed first probe for verified setup after a lost rotation', async () => {
    const gitlab = fakeGitlab()
    const setup = await ensure(gitlab, gitlab.exec, async () => ({ ok: false }))
    if (setup.ok || setup.binding === null) {
      throw new Error('fixture first probe did not fail')
    }
    const bindingId = setup.binding.bindingId
    expect(setup.binding.hookId).not.toBeNull()
    const lost = await rotate(bindingId, async (args, options) => {
      const response = await gitlab.exec(args, options)
      if (args.includes('PUT')) {
        throw new Error('rotation response lost')
      }
      return response
    })
    expect(lost).toMatchObject({ ok: false, code: 'unknown-outcome' })
    const applied = gitlab.hooks[0].token

    const rotated = await rotate(bindingId, gitlab.exec)

    expect(rotated.ok).toBe(true)
    expect(getProjectBinding(ctx, bindingId)).toMatchObject({
      state: 'failed',
      failure: { phase: 'verifying', code: 'probe-failed' },
      rotationPending: false
    })
    expect(authorizeProjectEventBinding(ctx, { bindingId, token: String(applied) }).ok).toBe(false)
    const verified = await ensure(gitlab)
    expect(verified.ok).toBe(true)
    expect(getProjectBinding(ctx, bindingId)?.state).toBe('connected')
    expect(authorizeProjectEventBinding(ctx, { bindingId, token: String(applied) }).ok).toBe(true)
  })

  it('rejects a staged secret on a connected binding until it is promoted', async () => {
    const gitlab = fakeGitlab()
    const ensured = await ensure(gitlab)
    if (!ensured.ok) {
      throw new Error('fixture binding did not connect')
    }
    const bindingId = ensured.binding.bindingId
    const active = readProjectBindingSecret(ctx, bindingId)?.secret ?? ''
    expect(stageProjectBindingSecretRotation(ctx, { bindingId, secret: 'staged-secret' }).ok).toBe(
      true
    )
    expect(getProjectBinding(ctx, bindingId)).toMatchObject({
      state: 'connected',
      rotationPending: true
    })

    expect(authorizeProjectEventBinding(ctx, { bindingId, token: 'staged-secret' })).toEqual({
      ok: false,
      status: 401,
      code: 'unauthorized'
    })
    expect(authorizeProjectEventBinding(ctx, { bindingId, token: active })).toMatchObject({
      ok: true
    })
  })

  it.each(['hooks-list-fails', 'write-rejected'] as const)(
    'still drops a fresh secret that this rotation provably never applied when the hooks %s',
    async (failure) => {
      const gitlab = fakeGitlab()
      const ensured = await ensure(gitlab)
      if (!ensured.ok) {
        throw new Error('fixture binding did not connect')
      }
      const bindingId = ensured.binding.bindingId
      const oldSecret = readProjectBindingSecret(ctx, bindingId)?.secret
      if (failure === 'write-rejected') {
        gitlab.setWriteStatus(403)
      }

      const rotated = await rotate(bindingId, async (args, options) => {
        if (failure === 'hooks-list-fails' && args.some((arg) => arg.includes('per_page=100'))) {
          throw new Error('network down')
        }
        return gitlab.exec(args, options)
      })

      expect(rotated.ok).toBe(false)
      expect(getProjectBinding(ctx, bindingId)?.rotationPending).toBe(false)
      expect(readProjectBindingSecret(ctx, bindingId)?.secret).toBe(oldSecret)
      expect(gitlab.hooks[0].token).toBe(oldSecret)
    }
  )

  it.each([
    ['forbidden hook permission', 'checking'],
    ['failed callback probe', 'verifying']
  ] as const)(
    'leaves a binding that failed for another reason failed after a successful rotation (%s)',
    async (_name, phase) => {
      const gitlab = fakeGitlab()
      const connected = await ensure(gitlab)
      if (!connected.ok) {
        throw new Error('fixture binding did not connect')
      }
      const bindingId = connected.binding.bindingId
      const unrelated =
        phase === 'checking'
          ? await ensure(gitlab, async (args, options) =>
              args.some((arg) => arg.endsWith('hooks?per_page=1'))
                ? { stdout: http(403, { message: 'denied' }), stderr: '' }
                : gitlab.exec(args, options)
            )
          : await ensure(gitlab, gitlab.exec, async () => ({ ok: false }))
      expect(unrelated.ok).toBe(false)
      const before = getProjectBinding(ctx, bindingId)
      expect(before).toMatchObject({ state: 'failed', failure: { phase } })

      const rotated = await rotate(bindingId, gitlab.exec)

      expect(rotated.ok).toBe(true)
      const after = getProjectBinding(ctx, bindingId)
      expect(after).toMatchObject({ state: 'failed', failure: before?.failure })
      expect(after?.rotationPending).toBe(false)
      expect(gitlab.hooks[0].token).toBe(readProjectBindingSecret(ctx, bindingId)?.secret)
    }
  )

  it('promotes the new secret but reports refused events as a failed binding', async () => {
    const gitlab = fakeGitlab({ rejectEvents: ['releases_events'] })
    const ensured = await ensure(gitlab)
    const bindingId = ensured.binding?.bindingId
    expect(bindingId).toBeTruthy()
    if (!bindingId) {
      return
    }
    const oldSecret = readProjectBindingSecret(ctx, bindingId)?.secret

    const rotated = await rotateProjectBindingSecret(ctx, {
      bindingId,
      repoPath: '/repo',
      exec: gitlab.exec
    })

    expect(rotated.ok).toBe(false)
    if (rotated.ok) {
      return
    }
    expect(rotated.code).toBe('event-configuration-rejected')
    expect(rotated.retryable).toBe(false)
    expect(rotated.binding).toMatchObject({
      state: 'failed',
      failure: { phase: 'verifying', code: 'event-configuration-rejected' },
      rotationPending: false
    })
    expect(rotated.binding?.rejectedEvents).toContain('releases_events')
    const newSecret = readProjectBindingSecret(ctx, bindingId)?.secret
    expect(newSecret).toBeTruthy()
    expect(newSecret).not.toBe(oldSecret)
    expect(gitlab.hooks[0].token).toBe(newSecret)
  })

  it('refuses to rotate a binding that has no stored secret', async () => {
    const bindingId = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: '/repo',
      gitlabHost: 'gitlab.test:8929',
      gitlabPath: 'group/demo',
      gitlabProjectId: 3,
      callbackUrl: `${receiverBaseUrl}/webhooks/gitlab/${bindingId}`
    })
    const gitlab = fakeGitlab()

    const rotated = await rotateProjectBindingSecret(ctx, {
      bindingId,
      repoPath: '/repo',
      exec: gitlab.exec
    })

    expect(rotated.ok).toBe(false)
    if (rotated.ok) {
      return
    }
    expect(rotated.code).toBe('secret-unavailable')
    expect(rotated.retryable).toBe(false)
    expect(gitlab.hooks).toHaveLength(0)
  })
})

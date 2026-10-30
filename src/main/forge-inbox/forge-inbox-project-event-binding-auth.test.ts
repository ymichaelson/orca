import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecretStore } from '../../shared/secret-store'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { setProjectBindingProgress, upsertProjectBinding } from './forge-inbox-project-binding'
import { authorizeProjectEventBinding } from './forge-inbox-project-event-binding-auth'
import {
  PROJECT_BINDING_PREVIOUS_SECRET_TTL_MS,
  promoteProjectBindingSecretRotation,
  setProjectBindingSecret,
  stageProjectBindingSecretRotation
} from './forge-inbox-project-binding-secret'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'

const REPO_ID = 'repo-1'
const SECRET = 'binding-secret-value'
const NEXT_SECRET = 'rotated-secret-value'

describe('project event binding admission auth', () => {
  let root: string
  let store: SecretStore
  let ctx: ForgeLedgerContext
  let bindingId: string
  let clock = 1000

  const advanceClock = (ms: number): void => {
    clock += ms
  }

  const previousSecretColumns = () =>
    ctx.db
      .prepare(
        `SELECT previous_secret_envelope, previous_secret_expires_at
         FROM project_bindings WHERE binding_id = ?`
      )
      .get(bindingId)

  const rotateOnce = (): void => {
    const staged = stageProjectBindingSecretRotation(ctx, {
      bindingId,
      secret: NEXT_SECRET
    })
    if (!staged.ok) {
      throw new Error(`fixture could not stage the rotation: ${staged.reason}`)
    }
    promoteProjectBindingSecretRotation(ctx, bindingId)
  }

  const connect = (id: string): void => {
    setProjectBindingProgress(ctx, id, { state: 'connected', hookId: 7 })
  }

  const authorize = (token: string, id: string = bindingId) =>
    authorizeProjectEventBinding(ctx, { bindingId: id, token })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-binding-auth-'))
    clock = 1000
    const opened = openForgeInboxDatabase(join(root, 'forge-inbox.sqlite'), 'host-1')
    store = fakeStore()
    ctx = { db: opened.db, hostId: opened.hostId, now: () => ++clock, secretStore: () => store }
    bindingId = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: '/repo',
      gitlabHost: 'gitlab.test',
      gitlabPath: 'group/demo',
      gitlabProjectId: 3,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
    })
    const stored = setProjectBindingSecret(ctx, { bindingId, secret: SECRET })
    if (!stored.ok) {
      throw new Error(`fixture could not store the binding secret: ${stored.reason}`)
    }
    linkProjectEventBinding(ctx, { repoId: REPO_ID, bindingId })
    updateProjectEventPolicy(ctx, {
      repoId: REPO_ID,
      expectedGeneration: 0,
      patch: { enabled: true }
    })
    connect(bindingId)
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('authorizes with the binding own secret and reports its project policy generation', () => {
    const result = authorize(SECRET)

    expect(result).toMatchObject({
      ok: true,
      bindingId,
      repoId: REPO_ID,
      policyGeneration: 1,
      policyEnabled: true
    })
  })

  it('rejects a token that is not this binding secret', () => {
    expect(authorize('some-other-secret')).toEqual({
      ok: false,
      status: 401,
      code: 'unauthorized'
    })
  })

  it('does not accept one binding secret for a different binding', () => {
    const other = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId: other,
      projectPath: '/other',
      gitlabHost: 'gitlab.test',
      gitlabPath: 'group/other',
      gitlabProjectId: 4,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${other}`
    })
    const stored = setProjectBindingSecret(ctx, { bindingId: other, secret: 'other-secret' })
    expect(stored.ok).toBe(true)
    connect(other)

    expect(authorize('other-secret')).toEqual({ ok: false, status: 401, code: 'unauthorized' })
    expect(authorize(SECRET, other)).toEqual({ ok: false, status: 401, code: 'unauthorized' })
  })

  it('reports an unknown binding id as not found', () => {
    expect(authorize(SECRET, randomUUID())).toEqual({
      ok: false,
      status: 404,
      code: 'not-found'
    })
  })

  it('refuses a binding that is still registering', () => {
    setProjectBindingProgress(ctx, bindingId, { state: 'registering' })

    expect(authorize(SECRET)).toEqual({
      ok: false,
      status: 409,
      code: 'binding-not-ready'
    })
  })

  it('refuses a binding whose failure is not retryable', () => {
    setProjectBindingProgress(ctx, bindingId, {
      state: 'failed',
      failure: { phase: 'verifying', code: 'event-configuration-rejected', retryable: false }
    })

    expect(authorize(SECRET)).toEqual({
      ok: false,
      status: 409,
      code: 'binding-not-ready'
    })
  })

  it('reports an unreadable secret as unavailable rather than authorizing', () => {
    store = fakeStore({
      decryptString: () => {
        throw new Error('keychain unavailable')
      }
    })

    expect(authorize(SECRET)).toEqual({ ok: false, status: 503, code: 'unavailable' })
  })

  it('reports a binding with no project link as having no policy', () => {
    const orphan = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId: orphan,
      projectPath: '/orphan',
      gitlabHost: 'gitlab.test',
      gitlabPath: 'group/orphan',
      gitlabProjectId: 9,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${orphan}`
    })
    expect(setProjectBindingSecret(ctx, { bindingId: orphan, secret: 'orphan-secret' }).ok).toBe(
      true
    )
    connect(orphan)

    expect(authorize('orphan-secret', orphan)).toMatchObject({
      ok: true,
      repoId: null,
      policyGeneration: null,
      policyEnabled: false
    })
  })

  it('admits a callback already in flight with the retired secret inside the rotation window', () => {
    rotateOnce()

    expect(authorize(NEXT_SECRET).ok).toBe(true)
    expect(authorize(SECRET).ok).toBe(true)
  })

  it('stops admitting the retired secret and clears it once the window ends', () => {
    rotateOnce()
    advanceClock(PROJECT_BINDING_PREVIOUS_SECRET_TTL_MS + 1)

    expect(authorize(SECRET)).toEqual({ ok: false, status: 401, code: 'unauthorized' })
    expect(previousSecretColumns()).toEqual({
      previous_secret_envelope: null,
      previous_secret_expires_at: null
    })
    expect(authorize(NEXT_SECRET).ok).toBe(true)
  })

  it('retires the previous secret at once when a fresh one is stored', () => {
    rotateOnce()

    expect(setProjectBindingSecret(ctx, { bindingId, secret: 'fresh-secret' }).ok).toBe(true)

    expect(authorize(SECRET)).toEqual({ ok: false, status: 401, code: 'unauthorized' })
    expect(authorize('fresh-secret').ok).toBe(true)
  })

  it('does not fall back to the retired secret when the live one cannot be read', () => {
    rotateOnce()
    store = fakeStore({
      decryptString: () => {
        throw new Error('keychain unavailable')
      }
    })

    expect(authorize(SECRET)).toEqual({ ok: false, status: 503, code: 'unavailable' })
  })
})

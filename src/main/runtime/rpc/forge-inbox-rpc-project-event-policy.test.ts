import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../../git/runner'
import type { GlabExecOptions } from '../../git/command-runner/glab-exec-file'
import { _resetRemoteNameListingCache } from '../../git/remote-name-listing'
import { _resetKnownHostsCache } from '../../gitlab/gitlab-known-host-probe'
import { _resetProjectRefCache } from '../../gitlab/gitlab-project-ref-resolution'
import type { ForgeLedgerContext } from '../../forge-inbox/forge-inbox-context'
import { openForgeInboxDatabase } from '../../forge-inbox/forge-inbox-database'
import {
  setProjectBindingProgress,
  upsertProjectBinding,
  type ProjectBindingProgress
} from '../../forge-inbox/forge-inbox-project-binding'
import { forgeInboxProjectBindingContextForRuntime } from '../../forge-inbox/forge-inbox-project-binding-runtime'
import { linkProjectEventBinding } from '../../forge-inbox/forge-inbox-project-event-link'
import { fakeGitlab, fakeStore } from '../../forge-inbox/forge-inbox-project-binding-test-fixture'
import { createReceiverSettingsFixture } from '../../project-events/project-event-receiver-settings-test-fixture'
import Database from '../../sqlite/sync-database'
import { createForgeRpcHarness, type ForgeRpcHarness } from './forge-inbox-rpc-test-kit'

const { gitExecFileAsyncMock, glabExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  glabExecFileAsyncMock: vi.fn()
}))

vi.mock('../../git/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunner>()
  return {
    ...actual,
    gitExecFileAsync: gitExecFileAsyncMock,
    glabExecFileAsync: glabExecFileAsyncMock
  }
})

const REMOTE_URL = 'https://gitlab.test:8929/group/demo.git'

const NO_REPO = { ok: false as const, code: 'repo-not-found' as const, retryable: false as const }

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('forge inbox project event policy rpc', () => {
  let harness: ForgeRpcHarness | undefined

  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    glabExecFileAsyncMock.mockReset()
    _resetKnownHostsCache()
    _resetProjectRefCache()
    _resetRemoteNameListingCache()
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === undefined) {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return { stdout: REMOTE_URL, stderr: '' }
      }
      throw new Error(`fatal: No such remote '${args[2] ?? ''}'`)
    })
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'auth' && args[1] === 'status' && args[2] === undefined) {
        return { stdout: 'Logged in to gitlab.test:8929 as root\n', stderr: '' }
      }
      throw new Error(`unexpected glab ${args.join(' ')}`)
    })
  })

  afterEach(async () => {
    await harness?.close()
    harness = undefined
  })

  const ownerHostId = async (): Promise<string> =>
    String((await harness!.ok('forgeInbox.getStatus', {})).ownerHostId)

  function seedLinkedBinding(
    repoId: string,
    gitlabProjectId: number,
    progress: ProjectBindingProgress
  ): string {
    const { db, hostId } = openForgeInboxDatabase(harness!.dbPath)
    const ctx: ForgeLedgerContext = {
      db,
      hostId,
      now: () => 2_000,
      secretStore: () => harness!.secretStore
    }
    try {
      const binding = upsertProjectBinding(ctx, {
        bindingId: randomUUID(),
        projectPath: '/work/repo',
        gitlabHost: 'gitlab.test:8929',
        gitlabPath: `group/demo-${gitlabProjectId}`,
        gitlabProjectId,
        callbackUrl: 'https://orca.example.com/project-events/callback'
      })
      linkProjectEventBinding(ctx, { repoId, bindingId: binding.bindingId })
      setProjectBindingProgress(ctx, binding.bindingId, progress)
      return binding.bindingId
    } finally {
      db.close()
    }
  }

  function bindingRow(bindingId: string): Record<string, unknown> {
    const { db } = openForgeInboxDatabase(harness!.dbPath)
    try {
      const row = db
        .prepare(
          `SELECT state, hook_id, failure_phase, failure_code, failed_at, retryable,
             rejected_events_json, updated_at FROM project_bindings WHERE binding_id = ?`
        )
        .get(bindingId)
      if (row === undefined) {
        throw new Error(`binding ${bindingId} is missing`)
      }
      return row
    } finally {
      db.close()
    }
  }

  it('returns no policy for a never-configured host without creating a ledger file', async () => {
    harness = await createForgeRpcHarness()
    const owner = await ownerHostId()

    const view = await harness.ok('forgeInbox.getProjectEventPolicy', {
      ownerHostId: owner,
      repoId: 'repo-1'
    })

    expect(view).toMatchObject({ ownerHostId: owner, repoId: 'repo-1', policy: null })
    expect(existsSync(harness.dbPath)).toBe(false)
  })

  it('commits the policy before any glab call and does not wait for the reconcile', async () => {
    const receiverSettings = createReceiverSettingsFixture()
    receiverSettings.update({ externalBaseUrl: 'https://orca.example.com' })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const execCalls: string[] = []
    let generationSeenByExec: number | null = null
    harness = await createForgeRpcHarness({
      receiverSettings,
      ownerOptions: {
        resolveProjectBindingContext: () => ({
          ok: true,
          repoPath: '/work/repo',
          connectionId: null,
          source: 'repo',
          explicitProjectRefText: null
        }),
        projectBindingExec: async (args: string[], _options?: GlabExecOptions) => {
          execCalls.push(args.join(' '))
          const side = new Database(harness!.dbPath)
          try {
            const row = side
              .prepare("SELECT generation FROM project_event_policies WHERE repo_id = 'repo-1'")
              .get()
            generationSeenByExec = row === undefined ? null : Number(row.generation)
          } finally {
            side.close()
          }
          await gate
          throw new Error('no network in tests')
        }
      }
    })
    const owner = await ownerHostId()

    try {
      const raced = await Promise.race([
        harness
          .ok('forgeInbox.updateProjectEventPolicy', {
            ownerHostId: owner,
            repoId: 'repo-1',
            expectedGeneration: 0,
            patch: { rules: 'Prefer focused diffs', enabled: true }
          })
          .then((value) => ({ kind: 'saved' as const, value })),
        new Promise<{ kind: 'blocked' }>((resolve) =>
          setTimeout(() => resolve({ kind: 'blocked' }), 1000)
        )
      ])

      expect(raced.kind).toBe('saved')
      if (raced.kind !== 'saved') {
        return
      }
      expect(raced.value).toMatchObject({
        ownerHostId: owner,
        repoId: 'repo-1',
        ok: true,
        generation: 1
      })

      await waitFor(() => execCalls.length > 0, 'the background identity lookup')
      expect(generationSeenByExec).toBe(1)

      const stored = await harness.ok('forgeInbox.getProjectEventPolicy', {
        ownerHostId: owner,
        repoId: 'repo-1'
      })
      expect(stored.policy).toMatchObject({
        rules: 'Prefer focused diffs',
        enabled: true,
        generation: 1
      })
    } finally {
      release()
      await flush()
      await flush()
    }
  })

  it('keeps the generation for a no-op save and answers a stale save explicitly', async () => {
    harness = await createForgeRpcHarness({
      ownerOptions: { resolveProjectBindingContext: () => NO_REPO }
    })
    const owner = await ownerHostId()

    const first = await harness.ok('forgeInbox.updateProjectEventPolicy', {
      ownerHostId: owner,
      repoId: 'repo-1',
      expectedGeneration: 0,
      patch: { rules: 'Prefer focused diffs' }
    })
    expect(first.generation).toBe(1)

    const noop = await harness.ok('forgeInbox.updateProjectEventPolicy', {
      ownerHostId: owner,
      repoId: 'repo-1',
      expectedGeneration: 1,
      patch: { rules: 'Prefer focused diffs' }
    })
    expect(noop.generation).toBe(1)

    const stale = await harness.ok('forgeInbox.updateProjectEventPolicy', {
      ownerHostId: owner,
      repoId: 'repo-1',
      expectedGeneration: 0,
      patch: { rules: 'late writer' }
    })
    expect(stale).toMatchObject({ ok: false, reason: 'stale-generation', generation: 1 })

    const stored = await harness.ok('forgeInbox.getProjectEventPolicy', {
      ownerHostId: owner,
      repoId: 'repo-1'
    })
    expect(stored.policy).toMatchObject({ rules: 'Prefer focused diffs', generation: 1 })
  })

  it('rejects a client-supplied path and unknown keys before writing the policy', async () => {
    harness = await createForgeRpcHarness({
      ownerOptions: { resolveProjectBindingContext: () => NO_REPO }
    })
    const owner = await ownerHostId()
    const bad = [
      {
        ownerHostId: owner,
        repoId: 'repo-1',
        expectedGeneration: 0,
        patch: { rules: 'x' },
        repoPath: '/etc/passwd'
      },
      {
        ownerHostId: owner,
        repoId: 'repo-1',
        expectedGeneration: 0,
        patch: { repoPath: '/etc/passwd' }
      },
      { ownerHostId: owner, repoId: '', expectedGeneration: 0, patch: {} },
      { ownerHostId: owner, repoId: 'repo-1', expectedGeneration: -1, patch: {} },
      { ownerHostId: owner, repoId: 'repo-1', expectedGeneration: 0, patch: { surprise: true } }
    ]

    for (const params of bad) {
      expect(
        (await harness.call('forgeInbox.updateProjectEventPolicy', params)).ok,
        JSON.stringify(params)
      ).toBe(false)
    }

    const stored = await harness.ok('forgeInbox.getProjectEventPolicy', {
      ownerHostId: owner,
      repoId: 'repo-1'
    })
    expect(stored.policy).toBeNull()
  })

  it('saves a folder workspace policy and reports a non-retryable no-git-remote state', async () => {
    harness = await createForgeRpcHarness({
      ownerOptions: {
        resolveProjectBindingContext: (repoId: string) =>
          repoId === 'folder-1' ? { ok: false, code: 'no-git-remote', retryable: false } : NO_REPO
      }
    })
    const owner = await ownerHostId()

    const saved = await harness.ok('forgeInbox.updateProjectEventPolicy', {
      ownerHostId: owner,
      repoId: 'folder-1',
      expectedGeneration: 0,
      patch: { enabled: true }
    })
    expect(saved).toMatchObject({ ownerHostId: owner, repoId: 'folder-1', ok: true, generation: 1 })

    const retried = await harness.ok('forgeInbox.retryProjectEvent', {
      ownerHostId: owner,
      repoId: 'folder-1'
    })
    expect(retried).toMatchObject({
      ownerHostId: owner,
      repoId: 'folder-1',
      ok: false,
      code: 'no-git-remote',
      retryable: false
    })

    const stored = await harness.ok('forgeInbox.getProjectEventPolicy', {
      ownerHostId: owner,
      repoId: 'folder-1'
    })
    expect(stored.policy).toMatchObject({ enabled: true, generation: 1 })
  })

  it('refuses a remote-host repo without any git or glab call', async () => {
    harness = await createForgeRpcHarness({
      ownerOptions: {
        resolveProjectBindingContext: forgeInboxProjectBindingContextForRuntime({
          requireStore: () => ({
            getRepo: (id: string) =>
              id === 'repo-1'
                ? {
                    id: 'repo-1',
                    path: '/remote/host/repo',
                    displayName: 'repo',
                    badgeColor: '#ffffff',
                    addedAt: 1,
                    connectionId: 'remote-1'
                  }
                : undefined
          })
        })
      }
    })
    const owner = await ownerHostId()

    const retried = await harness.ok('forgeInbox.retryProjectEvent', {
      ownerHostId: owner,
      repoId: 'repo-1'
    })

    expect(retried).toMatchObject({
      ownerHostId: owner,
      repoId: 'repo-1',
      ok: false,
      code: 'remote-host-repo',
      retryable: false
    })
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('reports the current binding without writing or requiring a retry', async () => {
    harness = await createForgeRpcHarness({
      ownerOptions: { resolveProjectBindingContext: () => NO_REPO }
    })
    await harness.ok('forgeInbox.updateProjectEventPolicy', {
      ownerHostId: await ownerHostId(),
      repoId: 'repo-open',
      expectedGeneration: 0,
      patch: { rules: 'open the ledger' }
    })
    const owner = await ownerHostId()
    const failedId = seedLinkedBinding('repo-1', 12, {
      state: 'failed',
      hookId: 9,
      failure: { phase: 'verifying', code: 'interrupted', retryable: true },
      rejectedEvents: ['push']
    })
    const connectedId = seedLinkedBinding('repo-2', 13, { state: 'connected', hookId: 42 })
    const failedBefore = bindingRow(failedId)
    const connectedBefore = bindingRow(connectedId)

    const failed = await harness.ok('forgeInbox.getProjectEventPolicy', {
      ownerHostId: owner,
      repoId: 'repo-1'
    })
    const connected = await harness.ok('forgeInbox.getProjectEventPolicy', {
      ownerHostId: owner,
      repoId: 'repo-2'
    })

    expect(failed).toMatchObject({ ownerHostId: owner, repoId: 'repo-1', policy: null })
    expect(failed.binding).toMatchObject({
      bindingId: failedId,
      gitlabHost: 'gitlab.test:8929',
      gitlabPath: 'group/demo-12',
      state: 'failed',
      hookId: 9,
      failure: { phase: 'verifying', code: 'interrupted', retryable: true },
      rejectedEvents: ['push']
    })
    expect(connected.binding).toMatchObject({
      bindingId: connectedId,
      state: 'connected',
      hookId: 42,
      failure: null
    })
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(bindingRow(failedId)).toEqual(failedBefore)
    expect(bindingRow(connectedId)).toEqual(connectedBefore)
  })

  it('binds plaintext-only storage only when the retry explicitly consents', async () => {
    const gitlab = fakeGitlab()
    const receiverSettings = createReceiverSettingsFixture()
    receiverSettings.update({ externalBaseUrl: 'https://orca.example.com' })
    harness = await createForgeRpcHarness({
      secretStore: fakeStore({
        isEncryptionAvailable: () => false,
        describeProtectionGap: () => 'no keychain on this host'
      }),
      receiverSettings,
      ownerOptions: {
        resolveProjectBindingContext: () => ({
          ok: true,
          repoPath: '/repo',
          connectionId: null,
          source: 'repo',
          explicitProjectRefText: null
        }),
        projectBindingExec: gitlab.exec,
        probeProjectEventBinding: async () => ({ ok: true })
      }
    })
    const owner = await ownerHostId()

    const refused = await harness.ok('forgeInbox.retryProjectEvent', {
      ownerHostId: owner,
      repoId: 'repo-1'
    })
    expect(refused).toMatchObject({
      ok: false,
      code: 'unprotected-storage',
      retryable: true,
      binding: { state: 'failed', secretProtection: null }
    })
    expect(gitlab.created).toEqual([])

    const accepted = await harness.ok('forgeInbox.retryProjectEvent', {
      ownerHostId: owner,
      repoId: 'repo-1',
      allowUnprotectedStorage: true
    })
    expect(accepted).toMatchObject({
      ok: true,
      binding: { state: 'connected', secretProtection: 'plaintext' }
    })
    expect(gitlab.created).toHaveLength(1)
  })
})

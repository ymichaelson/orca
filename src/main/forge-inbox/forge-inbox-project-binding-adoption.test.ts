import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { bindingCommentScopeForTarget } from './forge-inbox-comment-target-binding'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { getProjectBinding } from './forge-inbox-project-binding'
import { ensureProjectBinding, removeProjectBinding } from './forge-inbox-project-binding-reconcile'
import { fakeGitlab, fakeStore, receiverBaseUrl } from './forge-inbox-project-binding-test-fixture'
import { getProjectEventRepoLink } from './forge-inbox-project-event-link'

function barrier() {
  let release: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('project binding adoption', () => {
  let root: string
  let ctx: ForgeLedgerContext

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-binding-adoption-'))
    const opened = openForgeInboxDatabase(join(root, 'inbox.sqlite'), 'host-1')
    const store = fakeStore()
    let clock = 1000
    ctx = { ...opened, now: () => ++clock, secretStore: () => store }
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  const ensure = (
    gitlab: ReturnType<typeof fakeGitlab>,
    repoId: string,
    repoPath: string,
    exec = gitlab.exec
  ) =>
    ensureProjectBinding(ctx, {
      repoId,
      repoPath,
      explicitProjectRef: { host: gitlab.host, path: 'group/demo' },
      receiverBaseUrl,
      exec,
      probe: async () => ({ ok: true })
    })

  async function orphan(gitlab: ReturnType<typeof fakeGitlab>) {
    const first = await ensure(gitlab, 'repo-a', '/deleted-clone')
    if (!first.ok) {
      throw new Error('fixture did not connect')
    }
    const result = await removeProjectBinding(ctx, {
      bindingId: first.binding.bindingId,
      exec: async (args, options) => {
        if (args.includes('DELETE')) {
          throw new Error('delete response unavailable')
        }
        return gitlab.exec(args, options)
      }
    })
    expect(result.ok).toBe(false)
    expect(getProjectEventRepoLink(ctx, 'repo-a')).toBeNull()
    expect(getProjectBinding(ctx, first.binding.bindingId)?.failure?.code).toBe('cleanup-failed')
    return first.binding.bindingId
  }

  it('updates the adopted binding and comment broker to the new trusted clone path', async () => {
    const gitlab = fakeGitlab()
    const bindingId = await orphan(gitlab)

    const adopted = await ensure(gitlab, 'repo-b', '/new-clone')

    expect(adopted).toMatchObject({
      ok: true,
      binding: { bindingId, projectPath: '/new-clone' }
    })
    expect(getProjectBinding(ctx, bindingId)?.projectPath).toBe('/new-clone')
    expect(getProjectEventRepoLink(ctx, 'repo-b')?.bindingId).toBe(bindingId)
    expect(
      bindingCommentScopeForTarget(ctx, {
        instanceId: `gitlab:${gitlab.host}`,
        projectId: 'group/demo',
        kind: 'merge_request',
        iid: 7
      })?.repoPath
    ).toBe('/new-clone')
    expect(gitlab.hooks).toHaveLength(1)
  })

  it('refreshes the trusted path after a verified move by the same owner', async () => {
    const gitlab = fakeGitlab()
    const initial = await ensure(gitlab, 'repo-a', '/old-clone')
    if (!initial.ok) {
      throw new Error('fixture did not connect')
    }

    const moved = await ensure(gitlab, 'repo-a', '/moved-clone')

    expect(moved).toMatchObject({
      ok: true,
      binding: { bindingId: initial.binding.bindingId, projectPath: '/moved-clone' }
    })
    expect(getProjectBinding(ctx, initial.binding.bindingId)?.projectPath).toBe('/moved-clone')
    expect(gitlab.hooks).toHaveLength(1)
  })

  it.each(['success', 'rejected', 'lost-response'] as const)(
    'preserves the new owner when an orphan cleanup returns %s after adoption',
    async (outcome) => {
      const gitlab = fakeGitlab()
      const bindingId = await orphan(gitlab)
      const deleteStarted = barrier()
      const allowDelete = barrier()
      const adopted = barrier()
      const allowPermission = barrier()
      const jobs: Promise<unknown>[] = []
      try {
        const cleanup = removeProjectBinding(ctx, {
          bindingId,
          exec: async (args, options) => {
            if (args.includes('DELETE')) {
              deleteStarted.release()
              await allowDelete.promise
              if (outcome === 'rejected') {
                return { stdout: 'HTTP/1.1 403 Forbidden\r\n\r\n{}', stderr: '' }
              }
              const response = await gitlab.exec(args, options)
              if (outcome === 'lost-response') {
                throw new Error('delete response lost')
              }
              return response
            }
            return gitlab.exec(args, options)
          }
        })
        jobs.push(cleanup)
        await deleteStarted.promise
        const rebind = ensure(gitlab, 'repo-b', '/new-clone', async (args, options) => {
          if (args.some((arg) => arg.endsWith('/hooks?per_page=1'))) {
            adopted.release()
            await allowPermission.promise
          }
          return gitlab.exec(args, options)
        })
        jobs.push(rebind)
        await adopted.promise
        expect(getProjectEventRepoLink(ctx, 'repo-b')?.bindingId).toBe(bindingId)
        const before = getProjectBinding(ctx, bindingId)

        allowDelete.release()
        await cleanup

        expect(getProjectBinding(ctx, bindingId)).toEqual(before)
        expect(getProjectEventRepoLink(ctx, 'repo-b')?.bindingId).toBe(bindingId)
        allowPermission.release()
        expect((await rebind).ok).toBe(true)
        const current = getProjectBinding(ctx, bindingId)
        expect(current).toMatchObject({ state: 'connected', projectPath: '/new-clone' })
        expect(gitlab.hooks).toHaveLength(1)
        expect(gitlab.hooks[0].id).toBe(current?.hookId)
        expect(gitlab.hooks[0].description).toBe(`orca-project-event-binding:${bindingId}`)
      } finally {
        allowDelete.release()
        allowPermission.release()
        await Promise.allSettled(jobs)
      }
    }
  )
})

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecretStore } from '../../shared/secret-store'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import {
  getProjectEventRepoLink,
  linkProjectEventBinding,
  removeProjectEventRepoLink
} from './forge-inbox-project-event-link'
import { fakeStore, receiverBaseUrl } from './forge-inbox-project-binding-test-fixture'

describe('project event repository link store', () => {
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

  const binding = (gitlabProjectId: number): string => {
    const bindingId = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: '/repo',
      gitlabHost: 'gitlab.test:8929',
      gitlabPath: `group/demo-${gitlabProjectId}`,
      gitlabProjectId,
      callbackUrl: `${receiverBaseUrl}/webhooks/gitlab/${bindingId}`
    })
    return bindingId
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-link-'))
    dbPath = join(root, 'forge-inbox.sqlite')
    clock = 1000
    store = fakeStore()
    ctx = open()
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('links a repository to one binding and is idempotent for the same pair', () => {
    const bindingId = binding(1)

    const first = linkProjectEventBinding(ctx, { repoId: 'repo-1', bindingId })
    const second = linkProjectEventBinding(ctx, { repoId: 'repo-1', bindingId })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) {
      return
    }
    expect(first.link).toEqual(second.link)
    expect(first.link.repoId).toBe('repo-1')
    expect(first.link.bindingId).toBe(bindingId)
    expect(getProjectEventRepoLink(ctx, 'repo-1')).toEqual(first.link)
    expect(ctx.db.prepare('SELECT repo_id FROM project_event_repo_links').all()).toHaveLength(1)
  })

  it('keeps the first binding for a repository instead of silently rebinding it', () => {
    const firstBinding = binding(1)
    const secondBinding = binding(2)
    const linked = linkProjectEventBinding(ctx, { repoId: 'repo-1', bindingId: firstBinding })
    expect(linked.ok).toBe(true)

    const rebound = linkProjectEventBinding(ctx, { repoId: 'repo-1', bindingId: secondBinding })

    expect(rebound.ok).toBe(false)
    if (rebound.ok) {
      return
    }
    expect(rebound).toEqual({
      ok: false,
      reason: 'repo-already-linked',
      bindingId: firstBinding
    })
    expect(getProjectEventRepoLink(ctx, 'repo-1')?.bindingId).toBe(firstBinding)
    expect(getProjectEventRepoLink(ctx, 'repo-2')).toBeNull()
  })

  it('refuses to link one binding to a second repository', () => {
    const bindingId = binding(1)
    const linked = linkProjectEventBinding(ctx, { repoId: 'repo-1', bindingId })
    expect(linked.ok).toBe(true)

    const duplicate = linkProjectEventBinding(ctx, { repoId: 'repo-2', bindingId })

    expect(duplicate.ok).toBe(false)
    if (duplicate.ok) {
      return
    }
    expect(duplicate).toEqual({
      ok: false,
      reason: 'binding-already-linked',
      repoId: 'repo-1'
    })
    expect(getProjectEventRepoLink(ctx, 'repo-2')).toBeNull()
  })

  it('removes only the requested repository link', () => {
    const one = binding(1)
    const two = binding(2)
    linkProjectEventBinding(ctx, { repoId: 'repo-1', bindingId: one })
    linkProjectEventBinding(ctx, { repoId: 'repo-2', bindingId: two })

    expect(removeProjectEventRepoLink(ctx, 'repo-1')).toBe(true)
    expect(removeProjectEventRepoLink(ctx, 'repo-1')).toBe(false)

    expect(getProjectEventRepoLink(ctx, 'repo-1')).toBeNull()
    expect(getProjectEventRepoLink(ctx, 'repo-2')?.bindingId).toBe(two)
  })
})

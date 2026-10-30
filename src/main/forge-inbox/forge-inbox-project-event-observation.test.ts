import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecretStore } from '../../shared/secret-store'
import type { GlabExecOptions } from '../git/command-runner/glab-exec-file'
import { readForgeConfigState } from './forge-inbox-config'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { ingestForgeEvent } from './forge-inbox-ingest'
import { claimForgeNotifications } from './forge-inbox-notification-claim'
import { ingestForgeObservation } from './forge-inbox-observation'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { ensureProjectBinding } from './forge-inbox-project-binding-reconcile'
import { fakeGitlab, fakeStore, receiverBaseUrl } from './forge-inbox-project-binding-test-fixture'
import type { ProjectEventActionClaim } from './forge-inbox-project-event-action'
import { linkProjectEventDecisionItem } from './forge-inbox-project-event-action-link'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { observeProjectEventBindingHead } from './forge-inbox-project-event-observation'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { readForgeProjectInvalidationGeneration } from './forge-inbox-project-invalidation'
import { rowNumber, rowText } from './forge-inbox-rows'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

const REPO_ID = 'repo-1'
const GITLAB_HOST = 'gitlab.test'
const GITLAB_PROJECT_ID = 3
const PROJECT_PATH = 'group/demo'
const RULES = '合并请求需要评审。'

const MR_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'merge_request',
    project: { id: GITLAB_PROJECT_ID },
    merge_request: {
      iid: 7,
      title: 'Add thing',
      state: 'opened',
      source_branch: 'feat',
      target_branch: 'main'
    },
    object_attributes: { action: 'update', last_commit: { id: 'sha-1' } }
  })
)
const MR_BODY_SHA_2 = Buffer.from(
  JSON.stringify({
    object_kind: 'merge_request',
    project: { id: GITLAB_PROJECT_ID },
    merge_request: { iid: 7, title: 'Add thing', state: 'opened' },
    object_attributes: { action: 'update', last_commit: { id: 'sha-2' } }
  })
)
const NO_IID_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'merge_request',
    project: { id: GITLAB_PROJECT_ID },
    merge_request: { title: 'missing' }
  })
)
const PUSH_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'push',
    project: { id: 3 },
    ref: 'refs/heads/feature',
    before: 'a'.repeat(40),
    after: 'b'.repeat(40)
  })
)
const ISSUE_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'issue',
    project: { id: GITLAB_PROJECT_ID },
    issue: { iid: 9, title: 'Bug', state: 'opened', description: 'Steps' },
    object_attributes: { action: 'open' }
  })
)

const PIPELINE_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'pipeline',
    project: { id: GITLAB_PROJECT_ID },
    object_attributes: { id: 1001, status: 'failed', sha: 'c'.repeat(40), ref: 'feat' }
  })
)
const MR_NOTE_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'note',
    project: { id: GITLAB_PROJECT_ID },
    object_attributes: { id: 301, note: 'Please clarify', noteable_type: 'MergeRequest' },
    merge_request: { iid: 7, title: 'Add thing' }
  })
)

const mergeRequest = (sha: string) => ({
  iid: 7,
  state: 'opened',
  title: 'Add thing',
  description: 'Explains the fix',
  target_branch: 'main',
  source_branch: 'feat',
  draft: false,
  sha,
  diff_refs: { base_sha: 'b'.repeat(40), head_sha: sha, start_sha: 'd'.repeat(40) },
  author: { username: 'alice' },
  reviewers: [],
  assignees: [],
  updated_at: '2026-10-01T10:00:00.000Z'
})

const note = (id: number) => ({
  id,
  system: false,
  author: { username: 'alice' },
  body: `note ${id}`,
  updated_at: '2026-10-01T10:00:00.000Z'
})

const diff = {
  old_path: 'src/a.ts',
  new_path: 'src/a.ts',
  diff: '@@ -1 +1 @@\n-a\n+b\n',
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  generated_file: false
}

type GlabCall = { args: string[]; options?: GlabExecOptions }
type Exec = (
  args: string[],
  options?: GlabExecOptions
) => Promise<{ stdout: string; stderr: string }>

type MergeRequestFixture = ReturnType<typeof mergeRequest>

type GlabScript = {
  mergeRequest?: MergeRequestFixture | ((read: number) => MergeRequestFixture)
  issue?: unknown
  pipeline?: unknown
  notes?: unknown[]
  diffs?: unknown[]
  failure?: string
}

function glabResponse(body: unknown): string {
  return `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}`
}

function fakeGlab(script: GlabScript): {
  calls: GlabCall[]
  exec: Exec
  mergeRequestReads: () => number
} {
  const calls: GlabCall[] = []
  let mergeRequestReads = 0
  return {
    calls,
    mergeRequestReads: () => mergeRequestReads,
    exec: async (args, options) => {
      calls.push({ args, options })
      if (script.failure !== undefined) {
        throw Object.assign(new Error('glab failed'), { stderr: script.failure })
      }
      const route = args[4]
      if (route === `projects/${GITLAB_PROJECT_ID}/merge_requests/7`) {
        mergeRequestReads += 1
        const mergeRequest =
          typeof script.mergeRequest === 'function'
            ? script.mergeRequest(mergeRequestReads)
            : script.mergeRequest
        return { stdout: glabResponse(mergeRequest), stderr: '' }
      }
      if (route?.startsWith(`projects/${GITLAB_PROJECT_ID}/merge_requests/7/notes?`)) {
        return { stdout: glabResponse(script.notes ?? []), stderr: '' }
      }
      if (route?.startsWith(`projects/${GITLAB_PROJECT_ID}/merge_requests/7/diffs?`)) {
        return { stdout: glabResponse(script.diffs ?? []), stderr: '' }
      }
      if (route === `projects/${GITLAB_PROJECT_ID}/pipelines/1001`) {
        return { stdout: glabResponse(script.pipeline), stderr: '' }
      }
      if (route === `projects/${GITLAB_PROJECT_ID}/issues/9`) {
        return { stdout: glabResponse(script.issue), stderr: '' }
      }
      if (route?.startsWith(`projects/${GITLAB_PROJECT_ID}/issues/9/notes?`)) {
        return { stdout: glabResponse(script.notes ?? []), stderr: '' }
      }
      throw new Error(`unexpected glab route ${route}`)
    }
  }
}

describe('project event binding head observation', () => {
  let root: string
  let dbPath: string
  let store: SecretStore
  let ctx: ForgeLedgerContext
  let bindingId: string
  let clock: number
  let deliveries: number

  function open(): ForgeLedgerContext {
    const opened = openForgeInboxDatabase(dbPath, 'host-1')
    return { db: opened.db, hostId: opened.hostId, now: () => ++clock, secretStore: () => store }
  }

  // Why: claim the row directly so this suite does not depend on the action-ledger writer's module.
  function claimAction(
    body = MR_BODY,
    action: 'dispatch_agent' | 'notify' = 'dispatch_agent',
    eventKind = body === ISSUE_BODY ? 'Issue Hook' : 'Merge Request Hook'
  ): ProjectEventActionClaim {
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: PROJECT_PATH,
      policyGeneration: 1,
      policyEnabled: true,
      eventKind,
      dedupeKey: `delivery-${deliveries++}`,
      correlation: { eventUuid: null, configUuid: null },
      body
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }
    const token = randomUUID()
    const startedAt = ctx.now()
    const inserted = ctx.db
      .prepare(
        `INSERT INTO project_event_decisions (host_id, delivery_id, policy_generation, provider,
           model, action, confidence, input_tokens, output_tokens, decided_at,
           action_state, action_token, action_started_at)
         VALUES (?, ?, 1, 'jev', 'jev-1', ?, 0.8, 10, 2, ?, 'processing', ?, ?)`
      )
      .run(ctx.hostId, admitted.deliveryId, action, startedAt, token, startedAt)
    ctx.db
      .prepare(
        `UPDATE webhook_deliveries SET decision_state = 'processing', decision_token = ?,
           decision_started_at = ? WHERE id = ?`
      )
      .run(token, startedAt, admitted.deliveryId)
    return {
      decisionId: Number(inserted.lastInsertRowid),
      deliveryId: admitted.deliveryId,
      action,
      itemId: null,
      token,
      startedAt,
      bindingId,
      repoId: REPO_ID,
      generation: 1
    }
  }

  function linkHookRevision(): void {
    ingestForgeEvent(ctx, {
      hostId: ctx.hostId,
      instanceId: `gitlab:${GITLAB_HOST}`,
      projectId: PROJECT_PATH,
      kind: 'merge_request',
      iid: 7,
      dedupeKey: 'hook-sha-1',
      eventKind: 'Merge Request Hook',
      versionToken: 'hook:sha-1',
      sourceOrder: 0,
      payload: { source: 'hook' },
      title: 'Add thing',
      itemState: 'opened'
    })
  }

  function count(table: 'items' | 'item_revisions' | 'events'): number {
    const row = ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
    if (!row) {
      throw new Error(`no count row for ${table}`)
    }
    return rowNumber(row, 'n')
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-observation-'))
    dbPath = join(root, 'forge-inbox.sqlite')
    clock = 1000
    deliveries = 0
    store = fakeStore()
    ctx = open()
    bindingId = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: '/repo',
      gitlabHost: GITLAB_HOST,
      gitlabPath: PROJECT_PATH,
      gitlabProjectId: GITLAB_PROJECT_ID,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
    })
    linkProjectEventBinding(ctx, { repoId: REPO_ID, bindingId })
    updateProjectEventPolicy(ctx, {
      repoId: REPO_ID,
      expectedGeneration: 0,
      patch: { enabled: true, rules: RULES }
    })
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('observes through the current trusted path after its owner moves the clone', async () => {
    const gitlab = fakeGitlab({ host: GITLAB_HOST, projectId: GITLAB_PROJECT_ID })
    const moved = await ensureProjectBinding(ctx, {
      repoId: REPO_ID,
      repoPath: '/moved-clone',
      explicitProjectRef: { host: GITLAB_HOST, path: PROJECT_PATH },
      receiverBaseUrl,
      exec: gitlab.exec,
      probe: async () => ({ ok: true })
    })
    expect(moved.ok).toBe(true)
    const glab = fakeGlab({ mergeRequest: mergeRequest('a'.repeat(40)) })

    const observed = await observeProjectEventBindingHead(ctx, claimAction(), { exec: glab.exec })

    expect(observed.ok).toBe(true)
    expect(glab.calls.length).toBeGreaterThan(0)
    expect(glab.calls.every((call) => call.options?.cwd === '/moved-clone')).toBe(true)
  })

  it('records a changed observed head as revision 2 with the digest token', async () => {
    const claim = claimAction()
    linkHookRevision()
    const glab = fakeGlab({
      mergeRequest: mergeRequest('a'.repeat(40)),
      notes: [note(1)],
      diffs: [diff]
    })

    const observed = await observeProjectEventBindingHead(ctx, claim, { exec: glab.exec })

    expect(observed).toMatchObject({
      ok: true,
      itemId: 1,
      revision: 2,
      complete: true,
      newRevision: true
    })
    if (!observed.ok) {
      throw new Error('expected an observed head')
    }
    expect(glab.mergeRequestReads()).toBe(2)
    expect(observed.versionToken).toMatch(/^sha256:/)
    expect(
      ctx.db
        .prepare('SELECT current_revision, head_order, title, state FROM items WHERE id = 1')
        .get()
    ).toEqual({ current_revision: 2, head_order: 1, title: 'Add thing', state: 'opened' })
    expect(
      ctx.db
        .prepare(
          'SELECT revision, version_token FROM item_revisions WHERE item_id = 1 ORDER BY revision'
        )
        .all()
    ).toEqual([
      { revision: 1, version_token: 'hook:sha-1' },
      { revision: 2, version_token: observed.versionToken }
    ])
    const event = ctx.db
      .prepare(
        `SELECT revision, event_kind, version_token, source_order, payload_json FROM events
         ORDER BY id DESC LIMIT 1`
      )
      .get()
    if (!event) {
      throw new Error('expected the observed event')
    }
    expect(event).toMatchObject({
      revision: 2,
      event_kind: 'Merge Request Hook',
      version_token: observed.versionToken,
      source_order: 1
    })
    expect(JSON.parse(rowText(event, 'payload_json'))).toEqual({
      source: 'observed',
      kind: 'merge_request',
      iid: 7,
      sha: 'a'.repeat(40),
      complete: true
    })
  })

  it('keeps the head revision when the observed snapshot is unchanged', async () => {
    const firstClaim = claimAction()
    linkHookRevision()
    const glab = fakeGlab({
      mergeRequest: mergeRequest('a'.repeat(40)),
      notes: [note(1)],
      diffs: [diff]
    })

    const first = await observeProjectEventBindingHead(ctx, firstClaim, { exec: glab.exec })
    const second = await observeProjectEventBindingHead(ctx, claimAction(), { exec: glab.exec })

    expect(first).toMatchObject({ ok: true, revision: 2, newRevision: true })
    expect(second).toMatchObject({ ok: true, revision: 2, newRevision: false })
    expect(first.ok && first.versionToken).toBe(second.ok && second.versionToken)
    expect(glab.mergeRequestReads()).toBe(4)
    expect(count('item_revisions')).toBe(2)
    expect(
      ctx.db.prepare('SELECT current_revision, head_order FROM items WHERE id = 1').get()
    ).toEqual({ current_revision: 2, head_order: 2 })
    expect(
      ctx.db
        .prepare('SELECT version_token FROM item_revisions WHERE item_id = 1 AND revision = 2')
        .get()
    ).toEqual({ version_token: first.ok ? first.versionToken : null })
  })

  it('returns the GitLab failure and writes no item, revision, or event', async () => {
    const claim = claimAction()
    const glab = fakeGlab({ failure: 'glab: 404 Not Found (HTTP 404)' })

    expect(await observeProjectEventBindingHead(ctx, claim, { exec: glab.exec })).toEqual({
      ok: false,
      code: 'not-found'
    })

    expect(glab.calls).toHaveLength(1)
    expect(count('items')).toBe(0)
    expect(count('item_revisions')).toBe(0)
    expect(count('events')).toBe(0)
  })

  it('refuses a delivery body with no iid before any GitLab call', async () => {
    const claim = claimAction(NO_IID_BODY)
    const glab = fakeGlab({ mergeRequest: mergeRequest('a'.repeat(40)) })

    expect(await observeProjectEventBindingHead(ctx, claim, { exec: glab.exec })).toEqual({
      ok: false,
      code: 'item-identity-missing'
    })

    expect(glab.calls).toEqual([])
    expect(count('items')).toBe(0)
  })

  it('has no GitLab head to read for a project push', async () => {
    const claim = claimAction(PUSH_BODY, 'dispatch_agent', 'Push Hook')
    const glab = fakeGlab({ mergeRequest: mergeRequest('a'.repeat(40)) })

    expect(await observeProjectEventBindingHead(ctx, claim, { exec: glab.exec })).toEqual({
      ok: false,
      code: 'context-unavailable'
    })

    expect(glab.calls).toEqual([])
    expect(count('items')).toBe(0)
  })

  it('records an observed issue with no commit sha', async () => {
    const claim = claimAction(ISSUE_BODY)
    const glab = fakeGlab({
      issue: { iid: 9, state: 'opened', title: 'Bug', description: 'Steps' },
      notes: []
    })

    const observed = await observeProjectEventBindingHead(ctx, claim, { exec: glab.exec })

    expect(observed).toMatchObject({
      ok: true,
      itemId: 1,
      revision: 1,
      complete: true,
      newRevision: true
    })
    expect(ctx.db.prepare('SELECT kind, iid, title, state FROM items WHERE id = 1').get()).toEqual({
      kind: 'issue',
      iid: 9,
      title: 'Bug',
      state: 'opened'
    })
    const event = ctx.db.prepare('SELECT payload_json FROM events ORDER BY id DESC LIMIT 1').get()
    if (!event) {
      throw new Error('expected the observed event')
    }
    expect(JSON.parse(rowText(event, 'payload_json'))).toMatchObject({
      source: 'observed',
      kind: 'issue',
      sha: null
    })
  })

  it('observes the merge request a note was left on', async () => {
    const claim = claimAction(MR_NOTE_BODY, 'dispatch_agent', 'Note Hook')
    const glab = fakeGlab({
      mergeRequest: mergeRequest('a'.repeat(40)),
      notes: [note(1)],
      diffs: [diff]
    })

    expect(await observeProjectEventBindingHead(ctx, claim, { exec: glab.exec })).toMatchObject({
      ok: true,
      kind: 'merge_request',
      iid: 7
    })
    expect(ctx.db.prepare('SELECT kind, iid FROM items').all()).toEqual([
      { kind: 'merge_request', iid: 7 }
    ])
  })

  it('observes a standalone pipeline through its own id', async () => {
    const claim = claimAction(PIPELINE_BODY, 'dispatch_agent', 'Pipeline Hook')
    const glab = fakeGlab({
      pipeline: { id: 1001, status: 'success', sha: 'c'.repeat(40), ref: 'feat' }
    })

    expect(await observeProjectEventBindingHead(ctx, claim, { exec: glab.exec })).toMatchObject({
      ok: true,
      kind: 'pipeline',
      iid: 1001,
      sha: 'c'.repeat(40),
      state: 'success',
      newRevision: true
    })
    expect(ctx.db.prepare('SELECT kind, iid, title, state FROM items').all()).toEqual([
      { kind: 'pipeline', iid: 1001, title: 'Pipeline #1001', state: 'success' }
    ])
  })

  it('refuses a head that moves during every bounded snapshot attempt', async () => {
    const claim = claimAction()
    const glab = fakeGlab({
      mergeRequest: (read) => mergeRequest((read % 2 === 1 ? 'a' : 'b').repeat(40)),
      notes: [note(1)],
      diffs: [diff]
    })

    expect(await observeProjectEventBindingHead(ctx, claim, { exec: glab.exec })).toEqual({
      ok: false,
      code: 'head-moved'
    })

    expect(glab.mergeRequestReads()).toBe(4)
    expect(count('items')).toBe(0)
    expect(count('item_revisions')).toBe(0)
    expect(count('events')).toBe(0)
  })

  it('returns the persisted token when a duplicate claim observes a moved head', async () => {
    const claim = claimAction()
    const firstCall = fakeGlab({
      mergeRequest: mergeRequest('a'.repeat(40)),
      notes: [note(1)],
      diffs: [diff]
    })
    const first = await observeProjectEventBindingHead(ctx, claim, { exec: firstCall.exec })
    if (!first.ok) {
      throw new Error('expected the first observation')
    }

    const secondCall = fakeGlab({
      mergeRequest: mergeRequest('b'.repeat(40)),
      notes: [note(2)],
      diffs: [diff]
    })
    const second = await observeProjectEventBindingHead(ctx, claim, { exec: secondCall.exec })

    expect(second).toMatchObject({
      ok: true,
      itemId: first.itemId,
      revision: first.revision,
      versionToken: first.versionToken,
      complete: first.complete,
      newRevision: false
    })
    expect(count('item_revisions')).toBe(1)
    expect(count('events')).toBe(1)
  })

  it('refuses a delivery claimed under another binding', async () => {
    const claim = claimAction()
    ctx.db
      .prepare('UPDATE webhook_deliveries SET binding_id = ? WHERE id = ?')
      .run('another-binding', claim.deliveryId)
    const glab = fakeGlab({ mergeRequest: mergeRequest('a'.repeat(40)) })

    expect(await observeProjectEventBindingHead(ctx, claim, { exec: glab.exec })).toEqual({
      ok: false,
      code: 'binding-mismatch'
    })

    expect(glab.calls).toEqual([])
    expect(count('items')).toBe(0)
  })

  it('refuses a binding re-pointed away from the delivery project', async () => {
    const claim = claimAction()
    ctx.db
      .prepare('UPDATE project_bindings SET gitlab_path = ? WHERE binding_id = ?')
      .run('group/other', bindingId)
    const glab = fakeGlab({ mergeRequest: mergeRequest('a'.repeat(40)) })

    expect(await observeProjectEventBindingHead(ctx, claim, { exec: glab.exec })).toEqual({
      ok: false,
      code: 'binding-mismatch'
    })

    expect(glab.calls).toEqual([])
    expect(count('items')).toBe(0)
  })

  it('refuses an aborted signal without reading GitLab', async () => {
    const claim = claimAction()
    const controller = new AbortController()
    controller.abort()
    const glab = fakeGlab({ mergeRequest: mergeRequest('a'.repeat(40)) })

    expect(
      await observeProjectEventBindingHead(ctx, claim, {
        exec: glab.exec,
        signal: controller.signal
      })
    ).toEqual({ ok: false, code: 'aborted' })

    expect(glab.calls).toEqual([])
    expect(count('items')).toBe(0)
  })

  it('writes nothing when aborted during the read', async () => {
    const claim = claimAction()
    const controller = new AbortController()
    const calls: GlabCall[] = []
    const exec: Exec = async (args, options) => {
      calls.push({ args, options })
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError', stderr: '' })
    }

    expect(
      await observeProjectEventBindingHead(ctx, claim, { exec, signal: controller.signal })
    ).toEqual({ ok: false, code: 'aborted' })

    expect(calls).toHaveLength(1)
    expect(count('items')).toBe(0)
    expect(count('item_revisions')).toBe(0)
    expect(count('events')).toBe(0)
  })

  it('refuses a snapshot whose head advanced while the reads were in flight', async () => {
    const claim = claimAction()
    linkHookRevision()
    const glab = fakeGlab({
      mergeRequest: mergeRequest('a'.repeat(40)),
      notes: [note(1)],
      diffs: [diff]
    })
    let advanced = false
    const exec: Exec = async (args, options) => {
      if (!advanced) {
        advanced = true
        ingestForgeEvent(ctx, {
          hostId: ctx.hostId,
          instanceId: `gitlab:${GITLAB_HOST}`,
          projectId: PROJECT_PATH,
          kind: 'merge_request',
          iid: 7,
          dedupeKey: 'concurrent-sha-2',
          eventKind: 'Merge Request Hook',
          versionToken: 'hook:sha-2',
          sourceOrder: 1,
          payload: { source: 'hook' }
        })
      }
      return glab.exec(args, options)
    }

    expect(await observeProjectEventBindingHead(ctx, claim, { exec })).toEqual({
      ok: false,
      code: 'head-moved'
    })

    // Why: a snapshot read before the concurrent head landed must never become a higher revision.
    expect(
      ctx.db.prepare('SELECT current_revision, head_order FROM items WHERE id = 1').get()
    ).toEqual({ current_revision: 2, head_order: 1 })
    expect(count('item_revisions')).toBe(2)
    expect(count('events')).toBe(2)
  })

  it('returns the persisted revision when a repeated observation carries a stale expected head order', () => {
    linkHookRevision()
    const itemKey = {
      hostId: ctx.hostId,
      instanceId: `gitlab:${GITLAB_HOST}`,
      projectId: PROJECT_PATH,
      kind: 'merge_request' as const,
      iid: 7
    }
    const expectedConfigRevision = readForgeConfigState(ctx).revision
    const expectedInvalidationGeneration = readForgeProjectInvalidationGeneration(ctx, itemKey)
    const input = {
      ...itemKey,
      dedupeKey: 'obs:retry-token',
      eventKind: 'Merge Request Hook',
      versionToken: 'sha256:observed',
      payload: { source: 'observed' },
      title: 'Add thing',
      itemState: 'opened'
    }

    expect(
      ingestForgeObservation(ctx, input, expectedConfigRevision, expectedInvalidationGeneration, 0)
    ).toMatchObject({ ok: true, duplicate: false, revision: 2 })
    // Why: the first write advanced the head, so the retry's expectation is stale but its dedupe hit
    // must still report the persisted event rather than a moved head.
    expect(
      ingestForgeObservation(ctx, input, expectedConfigRevision, expectedInvalidationGeneration, 0)
    ).toMatchObject({ ok: true, duplicate: true, eventId: 2 })
  })

  it('keeps a reported notification when an unchanged observation repeats the same context', async () => {
    const reported = claimAction(MR_BODY, 'notify')
    const linked = linkProjectEventDecisionItem(ctx, reported)
    if (!linked.ok) {
      throw new Error(`fixture could not link the reported event: ${linked.reason}`)
    }
    const glab = fakeGlab({
      mergeRequest: mergeRequest('a'.repeat(40)),
      notes: [note(1)],
      diffs: [diff]
    })

    const first = await observeProjectEventBindingHead(ctx, claimAction(), { exec: glab.exec })
    const second = await observeProjectEventBindingHead(ctx, claimAction(), { exec: glab.exec })

    expect(first).toMatchObject({ ok: true, revision: 2, newRevision: true })
    expect(second).toMatchObject({ ok: true, revision: 2, newRevision: false })
    expect(first.ok && first.versionToken).toBe(second.ok && second.versionToken)

    // Why: an observation reads state; it must not swallow the notice the reported event still owns.
    expect(claimForgeNotifications(ctx).notifications).toEqual([
      expect.objectContaining({
        itemId: linked.itemId,
        reason: 'participating-update',
        eventId: 1
      })
    ])
  })

  it('keeps a reported notification when an observation advances to a different context', async () => {
    const reported = claimAction(MR_BODY, 'notify')
    const linked = linkProjectEventDecisionItem(ctx, reported)
    if (!linked.ok) {
      throw new Error(`fixture could not link the reported event: ${linked.reason}`)
    }
    const glab = fakeGlab({
      mergeRequest: mergeRequest('b'.repeat(40)),
      notes: [note(1)],
      diffs: [diff]
    })

    const observed = await observeProjectEventBindingHead(ctx, claimAction(), { exec: glab.exec })

    expect(observed).toMatchObject({ ok: true, revision: 2, newRevision: true })
    expect(claimForgeNotifications(ctx).notifications).toEqual([
      expect.objectContaining({
        itemId: linked.itemId,
        reason: 'participating-update',
        eventId: 1
      })
    ])
  })

  it('keeps a later reported notification claimable after an observation landed first', async () => {
    const first = claimAction(MR_BODY, 'notify')
    const firstLink = linkProjectEventDecisionItem(ctx, first)
    if (!firstLink.ok) {
      throw new Error(`fixture could not link the first reported event: ${firstLink.reason}`)
    }
    const glab = fakeGlab({
      mergeRequest: mergeRequest('a'.repeat(40)),
      notes: [note(1)],
      diffs: [diff]
    })
    await observeProjectEventBindingHead(ctx, claimAction(), { exec: glab.exec })

    // Why: the observation must not silence the notice stored before it.
    expect(claimForgeNotifications(ctx).notifications).toEqual([
      expect.objectContaining({
        itemId: firstLink.itemId,
        reason: 'participating-update',
        eventId: 1
      })
    ])

    const second = claimAction(MR_BODY_SHA_2, 'notify')
    const secondLink = linkProjectEventDecisionItem(ctx, second)
    if (!secondLink.ok) {
      throw new Error(`fixture could not link the second reported event: ${secondLink.reason}`)
    }

    // Why: the same observation must not silence a reported event stored after it either.
    expect(claimForgeNotifications(ctx).notifications).toEqual([
      expect.objectContaining({
        itemId: secondLink.itemId,
        reason: 'participating-update',
        eventId: 3
      })
    ])
  })
})

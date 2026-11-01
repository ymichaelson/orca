import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { ingestForgeEvent } from './forge-inbox-ingest'
import { createForgeInboxOwnerService } from './forge-inbox-owner-service'
import { PROJECT_EVENT_BINDING_ID } from './forge-inbox-owner-fixture-binding'
import * as observation from './forge-inbox-project-event-item-state-observation'
import { refreshOpenItemStatesOnOpen } from './forge-inbox-project-event-open-state-refresh'
import { BINDING_INSTANCE_PREFIX, upsertProjectBinding } from './forge-inbox-project-binding'
import {
  createGitlabApiReaderWithRequesters,
  type GitlabApiReader
} from './forge-inbox-gitlab-api-client'
import { createReceiverSettingsFixture } from '../project-events/project-event-receiver-settings-test-fixture'
import { fakeSecretStore } from './forge-inbox-webhook-test-harness'

const INSTANCE = `${BINDING_INSTANCE_PREFIX}gitlab.example.com`
const TOKEN = `hook:${'a'.repeat(40)}`

function admittedMergeRequest(ledger: ForgeInboxLedger, state: string): void {
  const ctx = ledger.ledgerContext()
  ingestForgeEvent(ctx, {
    hostId: ctx.hostId,
    instanceId: INSTANCE,
    projectId: 'group/demo',
    kind: 'merge_request',
    iid: 7,
    dedupeKey: 'hook-open',
    eventKind: 'Merge Request Hook',
    versionToken: TOKEN,
    sourceOrder: 0,
    payload: { kind: 'merge_request', iid: 7, action: 'open' },
    title: 'Add thing',
    itemState: state
  })
}

function bindingLedger(root: string): ForgeInboxLedger {
  const ledger = ForgeInboxLedger.open(join(root, 'forge-inbox.db'))
  try {
    const ctx = ledger.ledgerContext()
    upsertProjectBinding(ctx, {
      bindingId: PROJECT_EVENT_BINDING_ID,
      projectPath: '/repo',
      gitlabHost: 'gitlab.example.com',
      gitlabPath: 'group/demo',
      gitlabProjectId: 42,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${PROJECT_EVENT_BINDING_ID}`
    })
    // A link is what names the binding for a project; every delivery path has one.
    ctx.db
      .prepare(
        `INSERT INTO project_event_repo_links (host_id, repo_id, binding_id, created_at)
         VALUES (?, 'repo-1', ?, ?)`
      )
      .run(ctx.hostId, PROJECT_EVENT_BINDING_ID, ctx.now())
  } finally {
    ledger.close()
  }
  return ForgeInboxLedger.open(join(root, 'forge-inbox.db'))
}

/** Stands in for the verified snapshot taken before the merge: it outranks every reported hook. */
function recordSnapshot(ledger: ForgeInboxLedger, state: string): void {
  const ctx = ledger.ledgerContext()
  ctx.db
    .prepare(
      `INSERT INTO item_revisions (item_id, revision, version_token, source_order, created_at)
       SELECT 1, MAX(r.revision) + 1, 'sha256:snapshot', i.head_order + 1, ?
       FROM item_revisions r JOIN items i ON i.id = r.item_id`
    )
    .run(ctx.now())
  ctx.db
    .prepare(
      `UPDATE items SET state = ?, current_revision = (SELECT MAX(revision) FROM item_revisions
         WHERE item_id = 1), head_order = (SELECT MAX(source_order) FROM item_revisions
         WHERE item_id = 1) WHERE id = 1`
    )
    .run(state)
}

/** A finished decision is what the refresh looks for; what it decided does not matter here. */
function recordDecision(
  ledger: ForgeInboxLedger,
  body = '{"object_attributes":{"iid":7}}',
  dedupeKey = 'd1'
): void {
  const ctx = ledger.ledgerContext()
  ctx.db
    .prepare(
      `INSERT INTO webhook_deliveries (host_id, binding_id, project_id, dedupe_key, event_kind,
         admitted_at, state, decision_state, finished_at, body)
       VALUES (?, ?, 'group/demo', ?, 'Merge Request Hook', ?, 'done', 'decided', ?, ?)`
    )
    .run(ctx.hostId, PROJECT_EVENT_BINDING_ID, dedupeKey, ctx.now(), ctx.now(), Buffer.from(body))
  ctx.db
    .prepare(
      `INSERT INTO project_event_decisions (host_id, delivery_id, policy_generation, provider,
         model, action, confidence, input_tokens, output_tokens, decided_at, action_state)
       SELECT ?, MAX(id), 1, 'jev', 'jev-latest', 'fetch_context', 1, 0, 0, ?, 'done'
       FROM webhook_deliveries WHERE dedupe_key = ?`
    )
    .run(ctx.hostId, ctx.now(), dedupeKey)
}

function head(ledger: ForgeInboxLedger): { state: string; token: string } | undefined {
  const row = ledger
    .ledgerContext()
    .db.prepare(
      `SELECT i.state, r.version_token AS token FROM items i
       JOIN item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision`
    )
    .get()
  return row === undefined ? undefined : { state: String(row.state), token: String(row.token) }
}

/** A real reader over one fake endpoint: the project's merge request, or a failed read. */
function readerFor(state: string | null, reads: unknown[] = []) {
  return (): GitlabApiReader =>
    createGitlabApiReaderWithRequesters(
      {
        requester: {
          get: async (path) => {
            reads.push(path)
            return state === null
              ? { ok: false, code: 'network' }
              : {
                  ok: true,
                  headers: new Headers(),
                  json: {
                    iid: 7,
                    state,
                    title: 'Add thing',
                    description: '',
                    sha: 'b'.repeat(40),
                    updated_at: '2026-10-31T10:00:00Z',
                    author: { username: 'me' },
                    reviewers: [],
                    assignees: []
                  }
                }
          }
        },
        textRequester: { getText: async () => ({ ok: false, code: 'network' }) },
        instanceRequester: { get: async () => ({ ok: false, code: 'network' }) }
      },
      { baseUrl: 'https://gitlab.example.com', projectId: '42', expectedConfigRevision: 0 }
    )
}

describe('forge inbox project item state on open', () => {
  let roots: string[]
  let ledger: ForgeInboxLedger
  let failures: unknown[]

  beforeEach(() => {
    roots = []
    failures = []
    const root = mkdtempSync(join(tmpdir(), 'forge-state-refresh-'))
    roots.push(root)
    ledger = bindingLedger(root)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    try {
      ledger.close()
    } catch {
      // The owner-opening test closes the ledger it opened.
    }
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  const refresh = (state: string | null, reads: unknown[] = []) =>
    refreshOpenItemStatesOnOpen(ledger, {
      readerFor: readerFor(state, reads),
      onError: (error) => failures.push(error)
    })

  it('records the state GitLab reports over the stale one an item kept', async () => {
    admittedMergeRequest(ledger, 'opened')
    recordDecision(ledger)
    recordSnapshot(ledger, 'opened')

    const outcome = await refresh('merged')

    // The stale reading stays as history; the verified merge becomes the current one.
    expect([outcome, head(ledger), failures]).toEqual([
      1,
      { state: 'merged', token: 'state:merge_request:7:merged' },
      []
    ])
  })

  it('leaves an item no one chose to work on to its own decision', async () => {
    admittedMergeRequest(ledger, 'opened')
    const reads: unknown[] = []

    expect([await refresh('closed', reads), reads]).toEqual([0, []])
  })

  it('keeps the state a failed read could not confirm', async () => {
    admittedMergeRequest(ledger, 'opened')
    recordDecision(ledger)
    recordSnapshot(ledger, 'opened')

    expect([await refresh(null), head(ledger)?.state, failures]).toEqual([0, 'opened', []])
  })

  it('does not let a handled but cleared decision body hide the request it was about', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    admittedMergeRequest(ledger, 'opened')
    recordDecision(ledger)
    recordSnapshot(ledger, 'opened')
    ledger.ledgerContext().db.prepare(`UPDATE webhook_deliveries SET body = x''`).run()

    // Skipping the whole refresh is the honest outcome: nothing was misread, and no reason was logged.
    expect([await refresh('merged'), head(ledger)?.state, warn.mock.calls]).toEqual([
      0,
      'opened',
      []
    ])
  })

  it('matches a legacy decision by its delivery body, and survives one that is not JSON', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    admittedMergeRequest(ledger, 'opened')
    recordSnapshot(ledger, 'opened')
    recordDecision(ledger, 'not json', 'unreadable')
    recordDecision(ledger, '{"object_attributes":{"iid":7}}', 'legacy')

    // The unreadable one is skipped as data, not logged as a failure.
    expect([await refresh('merged'), head(ledger)?.state, warn.mock.calls.length]).toEqual([
      1,
      'merged',
      0
    ])
  })

  it('reads the state itself when the owner opens', async () => {
    admittedMergeRequest(ledger, 'opened')
    recordDecision(ledger)
    recordSnapshot(ledger, 'opened')
    const reads: unknown[] = []
    const read = vi.spyOn(observation, 'observeProjectEventItemState')
    read.mockImplementation(async (_ctx, _key, itemId) => {
      reads.push([itemId, 'merged'])
      return 'merged'
    })
    ledger.close()
    const service = createForgeInboxOwnerService({
      dbPath: join(roots[0] ?? '', 'forge-inbox.db'),
      http: { fetch: async () => new Response('{}') },
      secretStore: fakeSecretStore(),
      receiverSettings: createReceiverSettingsFixture(),
      ingress: { requestDeadlineMs: 5_000, shutdownGraceMs: 200 }
    })
    await service.start()
    await service.settled()
    await service.stop()

    expect(reads).toEqual([[1, 'merged']])
  })
})

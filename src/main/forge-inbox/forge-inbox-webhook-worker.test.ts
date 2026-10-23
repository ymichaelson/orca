import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import type { ForgeObservationInput } from './forge-inbox-observation'
import { INSTANCE_ID } from './forge-inbox-webhook-test-harness'
import {
  API_TOKEN,
  createWorkerRig,
  issueHookBody,
  mergeRequestHookBody,
  noteHookBody,
  overrideLedger,
  pipelineHookBody,
  SECRET_TEXT,
  type WorkerRig
} from './forge-inbox-webhook-worker-test-kit'

const SNAPSHOT_REQUESTS = [
  '/merge_requests/7',
  '/merge_requests/7/diffs',
  '/merge_requests/7/notes',
  '/merge_requests/7'
]

describe('forge inbox webhook worker decisions', () => {
  let rig: WorkerRig
  const start = (options: Parameters<typeof createWorkerRig>[0] = {}) => {
    rig = createWorkerRig(options)
    return rig
  }
  afterEach(() => {
    rig.dispose()
    vi.restoreAllMocks()
  })

  it('turns a relevant merge request hook into an item and one queued run through the API snapshot', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    start()
    const id = rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

    await expect(rig.worker().drainOnce()).resolves.toEqual({
      processed: 1,
      done: 1,
      failed: 0,
      needsAuth: 0,
      retry: 0
    })

    expect(rig.gitlab.requests).toEqual(SNAPSHOT_REQUESTS)
    expect(globalFetch).not.toHaveBeenCalled()
    expect(rig.items()).toMatchObject([
      { instance_id: INSTANCE_ID, project_id: '42', kind: 'merge_request', iid: 7, state: 'opened' }
    ])
    expect(rig.revisions()).toHaveLength(1)
    expect(rig.runs()).toEqual([{ state: 'queued', revision: 1 }])
    expect(rig.deliveries()).toMatchObject([{ id, state: 'done', body_bytes: 0 }])
    expect(rig.events()[0].payload).toMatchObject({
      category: 'review-request',
      completeness: { notes: true, diffs: true, complete: true }
    })
  })

  it('finishes a toggled-off category without a snapshot or an item', async () => {
    start({ project: { events: { reviewRequests: false } } })
    rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

    await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })

    expect(rig.gitlab.requests).toEqual([])
    expect(rig.items()).toEqual([])
  })

  it("finishes the user's own action without a snapshot or an item", async () => {
    start()
    rig.admit('merge_request', mergeRequestHookBody({ actor: 'ME', reviewers: ['me'] }))

    await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })

    expect(rig.gitlab.requests).toEqual([])
    expect(rig.items()).toEqual([])
  })

  it('settles a delivery whose project was disabled after admission before any worker sees it', async () => {
    start()
    rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
    rig.reconfigure({ enabled: false })

    expect(rig.deliveries()).toMatchObject([{ state: 'done', body_bytes: 0 }])
    await expect(rig.worker().drainOnce()).resolves.toMatchObject({ processed: 0 })

    expect(rig.gitlab.requests).toEqual([])
    expect(rig.items()).toEqual([])
  })

  it('keeps the item but queues no run when automatic analysis is off', async () => {
    start({ project: { automaticAnalysis: false, agentId: undefined, model: undefined } })
    rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

    await rig.worker().drainOnce()

    expect(rig.items()).toHaveLength(1)
    expect(rig.runs()).toEqual([])
  })

  describe('unknown relevance is decided from the API snapshot', () => {
    it.each([
      ['a reviewer', { reviewers: ['me'] }, 'review-request'],
      ['an assignee', { assignees: ['Me'] }, 'participating-update'],
      ['the author', { author: 'me' }, 'participating-update']
    ])('creates an item when a configured user is %s', async (_label, mergeRequest, category) => {
      start()
      Object.assign(rig.gitlab.state.mergeRequest, {
        reviewers: [],
        assignees: [],
        ...mergeRequest
      })
      rig.admit('merge_request', mergeRequestHookBody())

      await rig.worker().drainOnce()

      expect(rig.items()).toHaveLength(1)
      expect(rig.events()[0].payload).toMatchObject({ category })
    })

    it('finishes without an item when nobody configured is involved', async () => {
      start()
      Object.assign(rig.gitlab.state.mergeRequest, { reviewers: ['bob'], assignees: ['carol'] })
      rig.admit('merge_request', mergeRequestHookBody())

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })

      expect(rig.gitlab.requests.length).toBeGreaterThan(0)
      expect(rig.items()).toEqual([])
    })

    it('finishes without an item when the snapshot category toggle is off', async () => {
      start({ project: { events: { reviewRequests: false } } })
      rig.admit('merge_request', mergeRequestHookBody())

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })

      expect(rig.items()).toEqual([])
    })
  })

  describe('missing or rejected API credentials', () => {
    it('parks the delivery as needs-auth with its body until a credential is written', async () => {
      start({ apiToken: null })
      const id = rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ needsAuth: 1, done: 0 })
      expect(rig.gitlab.requests).toEqual([])
      expect(rig.items()).toEqual([])
      expect(rig.deliveries()).toMatchObject([{ id, state: 'needs-auth' }])
      expect(Number(rig.deliveries()[0].body_bytes)).toBeGreaterThan(0)

      rig.writeApiToken(API_TOKEN)
      expect(rig.deliveries()).toMatchObject([{ id, state: 'pending', attempts: 0 }])
      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })
      expect(rig.items()).toHaveLength(1)
    })

    it.each([401, 403])(
      'parks a delivery the API rejects with %i as needs-auth',
      async (status) => {
        start()
        rig.gitlab.state.override = () => new Response('{"message":"nope"}', { status })
        rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

        await expect(rig.worker().drainOnce()).resolves.toMatchObject({ needsAuth: 1 })

        expect(rig.items()).toEqual([])
        expect(rig.deliveries()).toMatchObject([{ state: 'needs-auth' }])
      }
    )
  })

  describe('API failures', () => {
    it('retries a rate limit no sooner than Retry-After', async () => {
      start()
      rig.gitlab.state.override = () =>
        new Response('{}', { status: 429, headers: { 'retry-after': '120' } })
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ retry: 1 })

      const [delivery] = rig.deliveries()
      expect(delivery).toMatchObject({ state: 'pending', last_error_code: 'api-rate-limited' })
      expect(Number(delivery.next_attempt_at)).toBeGreaterThanOrEqual(
        rig.ledger.nowMs() + 120_000 - 1000
      )
      expect(rig.items()).toEqual([])
    })

    it.each([
      ['a server error', () => new Response('boom', { status: 500 }), 'api-bad-response'],
      ['an unparseable body', () => new Response('not json', { status: 200 }), 'api-bad-response']
    ])('retries %s with a stable code', async (_label, respond, code) => {
      start()
      rig.gitlab.state.override = respond
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ retry: 1 })

      expect(rig.deliveries()).toMatchObject([{ state: 'pending', last_error_code: code }])
    })

    it('retries a network failure', async () => {
      start()
      rig.gitlab.state.onRequest = () => {
        throw new TypeError('connect ECONNREFUSED')
      }
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ retry: 1 })

      expect(rig.deliveries()).toMatchObject([{ last_error_code: 'api-network' }])
    })

    it('finishes without an item when the resource was deleted', async () => {
      start()
      rig.gitlab.state.override = () => new Response('{"message":"404 Not found"}', { status: 404 })
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })

      expect(rig.items()).toEqual([])
    })
  })

  describe('unusable bodies and isolation', () => {
    it.each([
      [
        'malformed',
        'merge_request' as const,
        `{"object_kind": "merge_request", "x": "${SECRET_TEXT}`
      ],
      ['unsupported', 'push' as const, JSON.stringify({ object_kind: 'push', note: SECRET_TEXT })]
    ])('fails a %s body terminally with a code and no payload text', async (kind, event, raw) => {
      start()
      rig.admit(event, null, raw)

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ failed: 1 })

      const [delivery] = rig.deliveries()
      expect(delivery).toMatchObject({ state: 'failed', last_error_code: `hook-${kind}` })
      expect(JSON.stringify(delivery)).not.toContain(SECRET_TEXT)
      expect(rig.items()).toEqual([])
    })

    it('does not let one bad delivery block the next', async () => {
      start()
      rig.admit('merge_request', null, '{broken')
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

      await expect(rig.worker().drainOnce()).resolves.toEqual({
        processed: 2,
        done: 1,
        failed: 1,
        needsAuth: 0,
        retry: 0
      })
      expect(rig.items()).toHaveLength(1)
    })

    it('turns an unexpected exception into a retry whose error column holds no message text', async () => {
      start()
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'], sha: 'c'.repeat(40) }))
      let calls = 0
      const worker = rig.worker((real) =>
        overrideLedger(real, {
          ingestObservation: (
            input: ForgeObservationInput,
            revision: number,
            generation: number
          ) => {
            calls += 1
            if (calls === 1) {
              throw new Error(`exploded near ${SECRET_TEXT}`)
            }
            return real.ingestObservation(input, revision, generation)
          }
        })
      )

      await expect(worker.drainOnce()).resolves.toMatchObject({ processed: 2, retry: 1, done: 1 })

      const deliveries = rig.deliveries()
      expect(deliveries[0]).toMatchObject({ state: 'pending', last_error_code: 'worker-error' })
      expect(JSON.stringify(deliveries)).not.toContain(SECRET_TEXT)
      expect(rig.items()).toHaveLength(1)
    })

    it("leaves another host's deliveries untouched", async () => {
      start()
      const connection = new Database(rig.harness.dbPath)
      try {
        connection
          .prepare(
            `INSERT INTO webhook_deliveries (host_id, instance_id, project_id, dedupe_key, event_kind,
               config_revision, admitted_at, state, body)
             VALUES ('host-b', ?, '42', 'foreign', 'Merge Request Hook', 1, 1, 'pending', x'7b7d')`
          )
          .run(INSTANCE_ID)

        await expect(rig.worker().drainOnce()).resolves.toMatchObject({ processed: 0 })

        expect(
          connection
            .prepare("SELECT state, attempts FROM webhook_deliveries WHERE host_id = 'host-b'")
            .get()
        ).toMatchObject({ state: 'pending', attempts: 0 })
      } finally {
        connection.close()
      }
    })

    it('does not reclaim a delivery it just scheduled for retry within the same drain', async () => {
      start()
      rig.gitlab.state.override = () => new Response('boom', { status: 500 })
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ processed: 1, retry: 1 })
      expect(rig.deliveries()[0]).toMatchObject({ attempts: 1 })
    })
  })

  describe('other hook kinds', () => {
    it('maps a note on a merge request that mentions the user to that merge request', async () => {
      start()
      rig.admit('note', noteHookBody('MergeRequest', 'ping @me about this'))

      await rig.worker().drainOnce()

      expect(rig.items()).toMatchObject([{ kind: 'merge_request', iid: 7 }])
    })

    it('observes an assigned issue with its notes', async () => {
      start()
      rig.admit('issue', issueHookBody({ assignees: ['me'] }))

      await rig.worker().drainOnce()

      expect(rig.gitlab.requests).toEqual(['/issues/3', '/issues/3/notes'])
      expect(rig.items()).toMatchObject([{ kind: 'issue', iid: 3 }])
      expect(rig.events()[0].payload).toMatchObject({
        category: 'issue-assignment',
        completeness: { notes: true, complete: true }
      })
    })

    it('makes each new issue note a new revision and ignores a repeated snapshot', async () => {
      start()
      rig.admit('issue', issueHookBody({ assignees: ['me'] }))
      await rig.worker().drainOnce()
      rig.admit('issue', issueHookBody({ assignees: ['me'] }))
      await rig.worker().drainOnce()
      expect(rig.revisions()).toHaveLength(1)

      rig.gitlab.state.issueNotes.push({ id: 1, body: 'cc @me', author: 'bob' })
      rig.admit('note', noteHookBody('Issue', 'cc @me'))
      await rig.worker().drainOnce()
      rig.gitlab.state.issueNotes.push({ id: 2, body: 'again @me', author: 'bob' })
      rig.admit('note', noteHookBody('Issue', 'again @me'))
      await rig.worker().drainOnce()

      expect(rig.revisions()).toHaveLength(3)
      expect(rig.items()).toHaveLength(1)
    })

    it('observes the merge request behind a failed pipeline when the user is involved', async () => {
      start()
      rig.gitlab.state.headPipeline = {
        id: 9,
        status: 'failed',
        sha: 'a'.repeat(40),
        ref: 'refs/merge-requests/7/head'
      }
      rig.admit('pipeline', pipelineHookBody('failed', { mergeRequest: 7 }))

      await rig.worker().drainOnce()

      expect(rig.items()).toMatchObject([{ kind: 'merge_request', iid: 7 }])
      expect(rig.events()[0].payload).toMatchObject({ category: 'pipeline-failure' })
    })

    it('ignores a failed pipeline on a merge request the user is not involved in', async () => {
      start()
      Object.assign(rig.gitlab.state.mergeRequest, { reviewers: ['bob'], author: 'alice' })
      rig.admit('pipeline', pipelineHookBody('failed', { mergeRequest: 7 }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })

      expect(rig.items()).toEqual([])
    })

    it('tracks a standalone failed pipeline only when the user triggered it', async () => {
      start()
      rig.admit('pipeline', pipelineHookBody('failed', { actor: 'bob' }))
      rig.admit('pipeline', pipelineHookBody('failed', { actor: 'me' }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ processed: 2, done: 2 })

      expect(rig.items()).toMatchObject([{ kind: 'pipeline', iid: 9 }])
      expect(rig.gitlab.requests).toEqual(['/pipelines/9'])
    })

    it('finishes a non-failed pipeline without a snapshot or an item', async () => {
      start()
      rig.admit('pipeline', pipelineHookBody('running', { actor: 'me' }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })

      expect(rig.gitlab.requests).toEqual([])
      expect(rig.items()).toEqual([])
    })
  })
})

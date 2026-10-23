import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { createForgeWebhookWorker } from './forge-inbox-webhook-worker'
import { INSTANCE_ID } from './forge-inbox-webhook-test-harness'
import {
  createWorkerRig,
  issueHookBody,
  mergeRequestHookBody,
  overrideLedger,
  type WorkerRig
} from './forge-inbox-webhook-worker-test-kit'

describe('forge inbox worker uncertainty boundaries', () => {
  let rig: WorkerRig
  afterEach(() => {
    vi.restoreAllMocks()
    rig.dispose()
  })

  it('defers a truncated notes no-match instead of marking unknown issue relevance done', async () => {
    rig = createWorkerRig()
    rig.gitlab.state.issue.assignees = []
    rig.admit('issue', issueHookBody())
    const worker = createForgeWebhookWorker({
      ledger: rig.ledger,
      http: {
        async fetch(url) {
          const request = new URL(url)
          if (request.pathname.endsWith('/issues/3/notes')) {
            const page = Number(request.searchParams.get('page') ?? 1)
            return Response.json(
              [
                {
                  id: page,
                  system: false,
                  author: { username: 'bob' },
                  body: 'no recipient',
                  updated_at: '2026-10-01'
                }
              ],
              { headers: { 'x-next-page': String(page + 1) } }
            )
          }
          return rig.gitlab.fetch(url)
        }
      }
    })

    await expect(worker.drainOnce()).resolves.toMatchObject({ retry: 1, done: 0 })

    expect(rig.items()).toEqual([])
    expect(rig.deliveries()).toMatchObject([
      { state: 'pending', last_error_code: 'relevance-incomplete' }
    ])
    expect(Number(rig.deliveries()[0].body_bytes)).toBeGreaterThan(0)
  })

  it('defers a description no-match beyond the mention scan budget', async () => {
    rig = createWorkerRig()
    rig.gitlab.state.issue.assignees = []
    rig.gitlab.state.issue.description = `${' '.repeat(64 * 1024)}@me`
    rig.admit('issue', issueHookBody())

    await expect(rig.worker().drainOnce()).resolves.toMatchObject({ retry: 1, done: 0 })

    expect(rig.deliveries()).toMatchObject([
      { state: 'pending', last_error_code: 'relevance-incomplete' }
    ])
    expect(rig.items()).toEqual([])
  })

  it.each([
    'not json',
    JSON.stringify({ instanceId: 'another-instance', kind: 'api-read', secret: 'fake-token' }),
    JSON.stringify({ instanceId: INSTANCE_ID, kind: 'api-write', secret: 'fake-token' }),
    JSON.stringify({ instanceId: INSTANCE_ID, kind: 'api-read', secret: 'bad\ntoken' })
  ])(
    'parks an unreadable or mismatched credential envelope without publishing its content',
    async (payload) => {
      rig = createWorkerRig()
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
      const decrypt = vi.spyOn(rig.harness.store, 'decryptString').mockReturnValue(payload)

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ needsAuth: 1, retry: 0 })

      expect(rig.deliveries()).toMatchObject([{ state: 'needs-auth' }])
      expect(Number(rig.deliveries()[0].body_bytes)).toBeGreaterThan(0)
      expect(rig.items()).toEqual([])
      expect(rig.gitlab.requests).toEqual([])
      decrypt.mockRestore()
      expect(rig.ledger.requeueNeedsAuthWebhookDeliveries(INSTANCE_ID)).toBe(1)
      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })
      expect(rig.items()).toHaveLength(1)
    }
  )

  it('keeps a database failure during a token read distinct from unavailable credentials', async () => {
    rig = createWorkerRig()
    rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
    const db = new Database(rig.harness.dbPath)
    const worker = rig.worker((real) =>
      overrideLedger(real, {
        readSecret: () => db.prepare('SELECT missing_column FROM credentials').get()
      })
    )
    try {
      await expect(worker.drainOnce()).resolves.toMatchObject({ retry: 1, needsAuth: 0 })
      expect(rig.deliveries()).toMatchObject([
        { state: 'pending', last_error_code: 'worker-error' }
      ])
      expect(rig.items()).toEqual([])
    } finally {
      db.close()
    }
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createForgeWebhookWorker } from './forge-inbox-webhook-worker'
import {
  createWorkerRig,
  issueHookBody,
  mergeRequestHookBody,
  noteHookBody,
  overrideLedger,
  pipelineHookBody,
  SHA_A,
  SHA_B,
  type WorkerRig
} from './forge-inbox-webhook-worker-test-kit'
import { INSTANCE_ID, PROJECT_ID } from './forge-inbox-webhook-test-harness'
import type { ForgeInboxLedger } from './forge-inbox-ledger'

function barrier() {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    async wait() {
      entered.resolve()
      await released.promise
    }
  }
}

describe('forge inbox observation specification regressions', () => {
  let rig: WorkerRig
  afterEach(() => {
    vi.restoreAllMocks()
    rig.dispose()
  })

  it.each([false, true])(
    'never exposes the obsolete same-SHA context when a note arrives during the final read (pruned history: %s)',
    async (prunedHistory) => {
      rig = createWorkerRig()
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
      if (prunedHistory) {
        const retired = rig.admit('note', noteHookBody('MergeRequest', 'older history'))
        rig.ledger.markWebhookDeliveryDone(retired)
        rig.restart()
      }
      const finalRead = barrier()
      const exposedBeforeFollowup: number[] = []
      let mrReads = 0
      const worker = createForgeWebhookWorker({
        ledger: rig.ledger,
        http: {
          async fetch(url) {
            const response = await rig.gitlab.fetch(url)
            if (new URL(url).pathname.endsWith('/merge_requests/7')) {
              mrReads += 1
              if (mrReads === 2) {
                await finalRead.wait()
              } else if (mrReads > 2) {
                exposedBeforeFollowup.push(rig.runs().length)
              }
            }
            return response
          }
        }
      })
      const draining = worker.drainOnce()
      await finalRead.entered
      try {
        if (prunedHistory) {
          expect(
            rig.ledger.pruneFinishedWebhookDeliveries({
              nowMs: rig.ledger.nowMs(),
              olderThanMs: 0,
              limit: 10
            })
          ).toBe(1)
        }
        rig.gitlab.state.notes.push({ id: 71, body: 'new context @me', author: 'bob' })
        rig.admit('note', noteHookBody('MergeRequest', 'new context @me', 'bob'))
      } finally {
        finalRead.release()
      }
      await draining

      expect.soft(exposedBeforeFollowup.length).toBeGreaterThan(0)
      expect.soft(exposedBeforeFollowup.every((count) => count === 0)).toBe(true)
      expect.soft(rig.revisions()).toHaveLength(1)
      expect.soft(rig.runs()).toEqual([{ state: 'queued', revision: 1 }])
      const latestToken = rig.revisions().at(-1)?.version_token
      rig.admit('note', noteHookBody('MergeRequest', 'new context @me', 'bob'))
      await worker.drainOnce()
      expect(rig.revisions().map((row) => row.version_token)).toEqual([latestToken])
    }
  )

  it('fences a new admission between the final API response and the ingest transaction', async () => {
    rig = createWorkerRig()
    rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
    let admitted = false
    const worker = rig.worker((real) =>
      overrideLedger(real, {
        ingestObservation: (...args: Parameters<ForgeInboxLedger['ingestObservation']>) => {
          if (!admitted) {
            admitted = true
            rig.gitlab.state.notes.push({ id: 72, body: 'transaction fence', author: 'bob' })
            rig.admit('note', noteHookBody('MergeRequest', 'transaction fence', 'bob'))
          }
          return real.ingestObservation(...args)
        }
      })
    )

    await worker.drainOnce()

    expect(rig.revisions()).toHaveLength(1)
    expect(rig.runs()).toEqual([{ state: 'queued', revision: 1 }])
  })

  it('does not dirty an observation when the authenticated admission is only a duplicate', async () => {
    rig = createWorkerRig()
    const body = mergeRequestHookBody({ reviewers: ['me'] })
    const id = rig.admit('merge_request', body)
    rig.gitlab.state.onRequest = (path, count) => {
      if (path === '/merge_requests/7' && count === 2) {
        expect(
          rig.ledger.admitWebhookDelivery({
            instanceId: INSTANCE_ID,
            projectId: PROJECT_ID,
            expectedConfigRevision: rig.ledger.getConfig().configRevision,
            eventKind: 'Merge Request Hook',
            dedupeKey: 'delivery-1',
            correlation: { eventUuid: null, configUuid: null },
            body: Buffer.from(JSON.stringify(body))
          })
        ).toMatchObject({ ok: true, duplicate: true, deliveryId: id })
      }
    }

    await expect(rig.worker().drainOnce()).resolves.toMatchObject({ processed: 1, done: 1 })

    expect(rig.revisions()).toHaveLength(1)
    expect(rig.runs()).toEqual([{ state: 'queued', revision: 1 }])
    expect(rig.gitlab.requests).toHaveLength(4)
  })

  it.each([false, true])(
    'serializes simultaneous drain calls without overlapping reads or reclaiming an active delivery (expired lease: %s)',
    async (expiredLease) => {
      rig = createWorkerRig()
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
      if (!expiredLease) {
        rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
      }
      const firstRead = barrier()
      let requests = 0
      let active = 0
      let peakActive = 0
      const worker = createForgeWebhookWorker({
        ledger: rig.ledger,
        http: {
          async fetch(url) {
            requests += 1
            active += 1
            peakActive = Math.max(peakActive, active)
            try {
              if (requests === 1) {
                await firstRead.wait()
              }
              return await rig.gitlab.fetch(url)
            } finally {
              active -= 1
            }
          }
        }
      })
      const first = worker.drainOnce()
      await firstRead.entered
      if (expiredLease) {
        rig.advance(16 * 60_000)
      }
      const second = worker.drainOnce()
      firstRead.release()
      await Promise.all([first, second])

      expect.soft(peakActive).toBe(1)
      expect.soft(rig.deliveries().every((row) => row.attempts === 1)).toBe(true)
      expect(rig.runs()).toEqual([{ state: 'queued', revision: 1 }])
    }
  )

  it('bounds one drain under continuous authenticated dirty traffic and leaves current work for the next drain', async () => {
    rig = createWorkerRig()
    rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
    let invalidations = 0
    rig.gitlab.state.onRequest = (path, count) => {
      if (path === '/merge_requests/7' && count % 2 === 0 && invalidations < 101) {
        invalidations += 1
        rig.gitlab.state.notes.push({
          id: invalidations,
          body: `update ${invalidations}`,
          author: 'bob'
        })
        rig.admit('note', noteHookBody('MergeRequest', `update ${invalidations}`, 'bob'))
      }
    }
    const worker = rig.worker()

    const first = await worker.drainOnce()

    expect.soft(first.processed).toBe(100)
    expect.soft(first.retry).toBe(100)
    expect.soft(rig.revisions()).toEqual([])
    expect.soft(rig.runs()).toEqual([])
    rig.gitlab.state.onRequest = () => {}
    await expect(worker.drainOnce()).resolves.toMatchObject({ done: 1 })
    expect(rig.runs()).toEqual([{ state: 'queued', revision: 1 }])
  })

  it('releases the single-flight latch after a claim failure so a later drain can recover', async () => {
    rig = createWorkerRig()
    rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
    let fail = true
    const worker = rig.worker((real) =>
      overrideLedger(real, {
        claimNextWebhookDelivery: (nowMs: number) => {
          if (fail) {
            fail = false
            throw new Error('claim temporarily unavailable')
          }
          return real.claimNextWebhookDelivery(nowMs)
        }
      })
    )

    await expect(worker.drainOnce()).rejects.toThrow('claim temporarily unavailable')
    await expect(worker.drainOnce()).resolves.toMatchObject({ done: 1 })
    expect(rig.runs()).toEqual([{ state: 'queued', revision: 1 }])
  })

  it.each(['issue', 'note'] as const)(
    'uses a non-system API-only issue-note mention for an unknown %s hook',
    async (kind) => {
      rig = createWorkerRig()
      rig.gitlab.state.issue.assignees = []
      rig.gitlab.state.issueNotes.push({ id: 9, body: 'please inspect @Me.', author: 'bob' })
      rig.admit(kind, kind === 'issue' ? issueHookBody() : noteHookBody('Issue', 'no recipient'))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })

      expect(rig.items()).toMatchObject([{ kind: 'issue', iid: 3 }])
      expect(rig.events()[0]?.payload).toMatchObject({ category: 'issue-mention' })
      expect(rig.runs()).toEqual([{ state: 'queued', revision: 1 }])
    }
  )

  it('honors the issue-mention toggle for API-only issue-note mentions', async () => {
    rig = createWorkerRig({ project: { events: { issueMentions: false } } })
    rig.gitlab.state.issue.assignees = []
    rig.gitlab.state.issueNotes.push({ id: 9, body: 'please inspect @me', author: 'bob' })
    rig.admit('issue', issueHookBody())

    await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })

    expect(rig.items()).toEqual([])
    expect(rig.runs()).toEqual([])
  })

  it.each([undefined, 7])(
    'finishes a disabled pipeline category without requiring API auth (MR: %s)',
    async (mergeRequest) => {
      rig = createWorkerRig({
        apiToken: null,
        project: { events: { pipelineFailures: false } }
      })
      rig.admit('pipeline', pipelineHookBody('failed', { actor: 'me', mergeRequest }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1, needsAuth: 0 })

      expect(rig.gitlab.requests).toEqual([])
      expect(rig.deliveries()).toMatchObject([{ state: 'done', body_bytes: 0 }])
      expect(rig.items()).toEqual([])
    }
  )

  it.each(['unavailable', 'decrypt-failed'] as const)(
    'retains an authenticated delivery as needs-auth when the SecretStore is %s and resumes after repair',
    async (failure) => {
      rig = createWorkerRig()
      const id = rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
      const unavailable = vi.spyOn(rig.harness.store, 'isEncryptionAvailable')
      const decrypt = vi.spyOn(rig.harness.store, 'decryptString')
      if (failure === 'unavailable') {
        unavailable.mockReturnValue(false)
      } else {
        decrypt.mockImplementation(() => {
          throw new Error('sensitive backend failure: fake-credential-bytes')
        })
      }

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ needsAuth: 1, retry: 0 })

      expect(rig.deliveries()).toMatchObject([{ id, state: 'needs-auth', attempts: 1 }])
      expect(Number(rig.deliveries()[0].body_bytes)).toBeGreaterThan(0)
      expect(JSON.stringify(rig.deliveries())).not.toContain('fake-credential-bytes')
      expect(rig.gitlab.requests).toEqual([])
      expect(rig.items()).toEqual([])
      unavailable.mockRestore()
      decrypt.mockRestore()
      rig.restart()
      expect(rig.ledger.requeueNeedsAuthWebhookDeliveries(INSTANCE_ID)).toBe(1)
      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })
      expect(rig.items()).toHaveLength(1)
    }
  )

  it.each(['null-refs', 'empty-base', 'empty-start', 'empty-head', 'null-source-sha'] as const)(
    'does not queue exact-version analysis for unready MR comparison identity %s',
    async (unready) => {
      rig = createWorkerRig()
      rig.gitlab.state.override = (path) => {
        if (path !== '/merge_requests/7') {
          return null
        }
        return Response.json({
          iid: 7,
          state: 'opened',
          title: 'Comparison still preparing',
          sha: unready === 'null-source-sha' ? null : SHA_A,
          target_branch: 'main',
          diff_refs:
            unready === 'null-refs'
              ? null
              : {
                  base_sha: unready === 'empty-base' ? '' : SHA_A,
                  start_sha: unready === 'empty-start' ? '' : SHA_A,
                  head_sha: unready === 'empty-head' ? '' : SHA_A
                },
          author: { username: 'alice' },
          reviewers: [{ username: 'me' }],
          assignees: [],
          updated_at: '2026-10-01T12:00:00.000Z'
        })
      }
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ retry: 1, done: 0 })

      expect(rig.revisions()).toEqual([])
      expect(rig.runs()).toEqual([])
    }
  )

  it.each([false, true])(
    'does not publish a source/head mismatch before a coherent comparison (ready in round two: %s)',
    async (readyInRoundTwo) => {
      rig = createWorkerRig()
      rig.gitlab.state.mergeRequest.sha = SHA_B
      let mrReads = 0
      rig.gitlab.state.override = (path) => {
        const ready = readyInRoundTwo && mrReads > 1
        if (path.endsWith('/diffs')) {
          return Response.json([
            { old_path: 'a.ts', new_path: 'a.ts', diff: `@@ ${ready ? SHA_B : SHA_A}` }
          ])
        }
        if (path !== '/merge_requests/7') {
          return null
        }
        mrReads += 1
        return Response.json({
          iid: 7,
          state: 'opened',
          title: 'Add thing',
          sha: SHA_B,
          target_branch: 'main',
          diff_refs: {
            base_sha: SHA_A,
            start_sha: SHA_A,
            head_sha: readyInRoundTwo && mrReads > 1 ? SHA_B : SHA_A
          },
          author: { username: 'alice' },
          reviewers: [{ username: 'me' }],
          assignees: [],
          updated_at: '2026-10-01T12:00:00.000Z'
        })
      }
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'], sha: SHA_B }))
      const worker = rig.worker()

      await expect(worker.drainOnce()).resolves.toMatchObject({
        done: readyInRoundTwo ? 1 : 0,
        retry: readyInRoundTwo ? 0 : 1
      })

      expect(rig.gitlab.requests).toEqual(
        readyInRoundTwo
          ? [
              '/merge_requests/7',
              '/merge_requests/7',
              '/merge_requests/7/diffs',
              '/merge_requests/7/notes',
              '/merge_requests/7'
            ]
          : ['/merge_requests/7', '/merge_requests/7']
      )
      if (!readyInRoundTwo) {
        expect(rig.items()).toEqual([])
        expect(rig.revisions()).toEqual([])
        expect(rig.runs()).toEqual([])
        expect(rig.deliveries()).toMatchObject([
          { state: 'pending', last_error_code: 'head-moving', attempts: 1 }
        ])
        expect(Number(rig.deliveries()[0].body_bytes)).toBeGreaterThan(0)
        return
      }
      expect(rig.items()).toHaveLength(1)
      expect(rig.runs()).toEqual([{ state: 'queued', revision: 1 }])
      const token = rig.revisions()[0]?.version_token
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'], sha: SHA_B }))
      await worker.drainOnce()
      expect(rig.revisions().map((row) => row.version_token)).toEqual([token])
      expect(rig.runs()).toEqual([{ state: 'queued', revision: 1 }])
    }
  )

  it.each(['base_sha', 'start_sha', 'head_sha', 'target_branch'] as const)(
    'does not pair earlier diffs with changed comparison identity %s',
    async (field) => {
      rig = createWorkerRig()
      let changed = false
      let diffReads = 0
      rig.gitlab.state.override = (path) => {
        if (path.endsWith('/diffs')) {
          diffReads += 1
          const diff = changed ? 'new comparison' : 'old comparison'
          changed = true
          return Response.json([{ old_path: 'a.ts', new_path: 'a.ts', diff }])
        }
        if (path === '/merge_requests/7') {
          const refs = { base_sha: SHA_A, start_sha: SHA_A, head_sha: SHA_A }
          if (field !== 'target_branch' && changed) {
            refs[field] = SHA_B
          }
          return Response.json({
            iid: 7,
            state: 'opened',
            title: 'Add thing',
            sha: field === 'head_sha' && changed ? SHA_B : SHA_A,
            target_branch: field === 'target_branch' && changed ? 'release' : 'main',
            diff_refs: refs,
            author: { username: 'alice' },
            reviewers: [{ username: 'me' }],
            assignees: [],
            updated_at: '2026-10-01T12:00:00.000Z'
          })
        }
        return null
      }
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })
      const firstToken = rig.revisions()[0]?.version_token
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
      await rig.worker().drainOnce()

      expect.soft(diffReads).toBe(3)
      expect(rig.revisions().map((row) => row.version_token)).toEqual([firstToken])
    }
  )
})

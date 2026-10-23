import { afterEach, describe, expect, it } from 'vitest'
import type { ForgeObservationInput } from './forge-inbox-observation'
import {
  createWorkerRig,
  mergeRequestHookBody,
  overrideLedger,
  SHA_A,
  SHA_B,
  type WorkerRig
} from './forge-inbox-webhook-worker-test-kit'

const SIXTEEN_MINUTES = 16 * 60_000

describe('forge inbox authoritative observation', () => {
  let rig: WorkerRig
  afterEach(() => rig.dispose())

  const observe = async (
    change: (mr: WorkerRig['gitlab']['state']['mergeRequest']) => void,
    hookSha = SHA_A
  ) => {
    change(rig.gitlab.state.mergeRequest)
    rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'], sha: hookSha }))
    return rig.worker().drainOnce()
  }
  const tokens = () => rig.revisions().map((row) => String(row.version_token))
  const orders = () => rig.events().map((row) => row.sourceOrder)

  it('records A to B to A as three revisions ordered by durable observation sequence', async () => {
    rig = createWorkerRig()
    await observe(() => {})
    await observe((mr) => (mr.sha = SHA_B))
    await observe((mr) => (mr.sha = SHA_A))

    const [first, second, third] = tokens()
    expect(rig.revisions()).toHaveLength(3)
    expect(third).toBe(first)
    expect(second).not.toBe(first)
    expect(orders()).toEqual([1, 2, 3])
    expect(rig.runs().map((run) => run.state)).toEqual(['superseded', 'superseded', 'queued'])
  })

  it('never takes the head from a late hook reporting an older SHA', async () => {
    rig = createWorkerRig()
    await observe((mr) => (mr.sha = SHA_B), SHA_B)
    const [head] = tokens()

    await observe(() => {}, SHA_A)

    expect(tokens()).toEqual([head])
    expect(rig.runs()).toHaveLength(1)
  })

  it('creates a new revision for a head change that shares the second-granular updated_at', async () => {
    rig = createWorkerRig()
    await observe(() => {})
    await observe((mr) => (mr.sha = SHA_B))

    expect(new Set(tokens()).size).toBe(2)
  })

  it('records unrelated updated_at churn as an event without a revision or a run', async () => {
    rig = createWorkerRig()
    await observe(() => {})
    await observe((mr) => (mr.updated_at = '2026-10-02T09:00:00.000Z'))

    expect(rig.revisions()).toHaveLength(1)
    expect(rig.events()).toHaveLength(2)
    expect(rig.runs()).toEqual([{ state: 'queued', revision: 1 }])
  })

  it('makes a new note on the same SHA a new revision', async () => {
    rig = createWorkerRig()
    await observe(() => {})
    rig.gitlab.state.notes.push({ id: 11, body: 'please look', author: 'bob' })
    await observe(() => {})

    expect(rig.revisions()).toHaveLength(2)
    expect(rig.runs().map((run) => run.revision)).toEqual([1, 2])
  })

  it('keeps the order counter across a restart', async () => {
    rig = createWorkerRig()
    await observe(() => {})
    rig.restart()
    await observe((mr) => (mr.sha = SHA_B))

    expect(orders()).toEqual([1, 2])
  })

  describe('snapshot stability', () => {
    it('rereads once when the head moved during the snapshot and publishes the settled one', async () => {
      rig = createWorkerRig()
      rig.gitlab.state.onRequest = (path, count) => {
        if (path.endsWith('/diffs') && count === 1) {
          rig.gitlab.state.mergeRequest.sha = SHA_B
        }
      }
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })

      expect(rig.gitlab.requests.filter((path) => path === '/merge_requests/7')).toHaveLength(4)
      const settled = createWorkerRig()
      settled.gitlab.state.mergeRequest.sha = SHA_B
      settled.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
      await settled.worker().drainOnce()
      expect(tokens()).toEqual(settled.revisions().map((row) => String(row.version_token)))
      settled.dispose()
    })

    it('publishes nothing and retries when the head keeps moving', async () => {
      rig = createWorkerRig()
      rig.gitlab.state.onRequest = (path) => {
        if (path.endsWith('/diffs')) {
          const mr = rig.gitlab.state.mergeRequest
          mr.sha = mr.sha === SHA_A ? SHA_B : SHA_A
        }
      }
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ retry: 1 })

      expect(rig.deliveries()).toMatchObject([{ state: 'pending', last_error_code: 'head-moving' }])
      expect(rig.gitlab.requests.filter((path) => path === '/merge_requests/7')).toHaveLength(4)
      expect(rig.items()).toEqual([])
    })

    it('discards a snapshot when the config changed while it was being read, then succeeds later', async () => {
      rig = createWorkerRig()
      rig.gitlab.state.onRequest = (path, count) => {
        if (path.endsWith('/notes') && count === 1) {
          rig.reconfigure({ rules: 'new rules' })
        }
      }
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ retry: 1 })
      expect(rig.deliveries()).toMatchObject([{ last_error_code: 'stale-config' }])
      expect(rig.items()).toEqual([])

      rig.gitlab.state.onRequest = () => {}
      rig.advance(SIXTEEN_MINUTES)
      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })
      expect(rig.items()).toHaveLength(1)
    })

    it('discards a snapshot when the config changes between the last read and the write', async () => {
      rig = createWorkerRig()
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
      const worker = rig.worker((real) =>
        overrideLedger(real, {
          ingestObservation: (
            input: ForgeObservationInput,
            revision: number,
            generation: number
          ) => {
            rig.reconfigure({ rules: 'changed after the snapshot' })
            return real.ingestObservation(input, revision, generation)
          }
        })
      )

      await expect(worker.drainOnce()).resolves.toMatchObject({ retry: 1 })

      expect(rig.deliveries()).toMatchObject([{ last_error_code: 'stale-config' }])
      expect(rig.items()).toEqual([])
    })

    it('discards a snapshot read with a credential that was rotated mid-flight', async () => {
      rig = createWorkerRig()
      rig.gitlab.state.onRequest = (path, count) => {
        if (path.endsWith('/diffs') && count === 1) {
          rig.writeApiToken('glpat-rotated-token')
        }
      }
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))

      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ retry: 1 })

      expect(rig.deliveries()).toMatchObject([{ last_error_code: 'stale-config' }])
      expect(rig.items()).toEqual([])
    })
  })

  it('publishes a truncated snapshot and carries the incompleteness on the event', async () => {
    rig = createWorkerRig()
    rig.gitlab.state.diffsHaveMore = true
    await observe(() => {})
    rig.gitlab.state.diffsHaveMore = false
    await observe(() => {})

    expect(rig.events()[0].payload).toMatchObject({
      completeness: { notes: true, diffs: false, complete: false }
    })
    expect(rig.events()[1].payload).toMatchObject({ completeness: { complete: true } })
    expect(rig.revisions()).toHaveLength(2)
  })

  describe('ledger observation entry', () => {
    let sequence = 0
    const input = (token: string, queueRun = true) => ({
      hostId: rig.ledger.hostId,
      instanceId: 'gitlab-main',
      projectId: '42',
      kind: 'merge_request' as const,
      iid: 7,
      dedupeKey: `k-${(sequence += 1)}`,
      eventKind: 'observed',
      payload: null,
      versionToken: token,
      ...(queueRun ? { queueRun: { reason: 'auto' } } : {})
    })

    it('allocates watermark plus one inside the write and drops a run for a redundant token', () => {
      rig = createWorkerRig()
      const revision = rig.ledger.getConfig().configRevision
      const generation = rig.ledger.readProjectInvalidationGeneration({
        instanceId: 'gitlab-main',
        projectId: '42'
      })
      const first = rig.ledger.ingestObservation(input('t1'), revision, generation)
      const redundant = rig.ledger.ingestObservation(input('t1', true), revision, generation)
      const changed = rig.ledger.ingestObservation(input('t2'), revision, generation)

      expect(first).toMatchObject({ ok: true, newRevision: true })
      expect(redundant).toMatchObject({ ok: true, newRevision: false, runId: null })
      expect(changed).toMatchObject({ ok: true, newRevision: true })
      expect(orders()).toEqual([1, 2, 3])
      expect(rig.runs().map((run) => run.state)).toEqual(['superseded', 'queued'])
    })

    it('writes nothing when the config revision moved before the write', () => {
      rig = createWorkerRig()
      const stale = rig.ledger.getConfig().configRevision
      rig.reconfigure({ rules: 'changed' })

      expect(rig.ledger.ingestObservation(input('t1'), stale, 0)).toEqual({
        ok: false,
        reason: 'stale-config'
      })
      expect(rig.items()).toEqual([])
      expect(rig.events()).toEqual([])
    })
  })

  describe('crash recovery', () => {
    it('does not duplicate the event, revision or run when the delivery is processed again', async () => {
      rig = createWorkerRig()
      rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
      const dying = rig.worker((real) =>
        overrideLedger(real, {
          markWebhookDeliveryDone: () => {
            throw new Error('process died before marking done')
          }
        })
      )
      await expect(dying.drainOnce()).resolves.toMatchObject({ retry: 1 })
      expect(rig.events()).toHaveLength(1)

      rig.restart()
      rig.advance(SIXTEEN_MINUTES)
      await expect(rig.worker().drainOnce()).resolves.toMatchObject({ done: 1 })

      expect(rig.deliveries()).toMatchObject([{ state: 'done' }])
      expect(rig.items()).toHaveLength(1)
      expect(rig.events()).toHaveLength(1)
      expect(rig.revisions()).toHaveLength(1)
      expect(rig.runs()).toHaveLength(1)
    })
  })
})

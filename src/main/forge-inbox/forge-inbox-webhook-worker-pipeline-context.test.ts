import { afterEach, describe, expect, it } from 'vitest'
import {
  createWorkerRig,
  mergeRequestHookBody,
  SHA_A,
  type WorkerRig
} from './forge-inbox-webhook-worker-test-kit'
import { PROJECT_ID } from './forge-inbox-webhook-test-harness'

const SHA_MERGED = 'e'.repeat(40)
const MR_REF = 'refs/merge-requests/7/head'
const OTHER_PROJECT = Number(PROJECT_ID) + 1000

// Official GET /merge_requests/:iid head_pipeline fields, including churn-prone timestamps.
const headPipeline = (
  id: number,
  status: string,
  sha = SHA_A,
  updatedAt = '2026-10-01T11:00:00Z'
) => ({
  id,
  iid: id - 50,
  project_id: Number(PROJECT_ID),
  sha,
  ref: MR_REF,
  status,
  source: 'merge_request_event',
  created_at: '2026-10-01T10:00:00Z',
  updated_at: updatedAt,
  web_url: `https://gitlab.example.com/group/project/-/pipelines/${id}`
})

const pipelineHook = (
  id: number,
  options: { sha?: string; finishedAt?: string; actor?: string; mergeRequest?: object | null } = {}
) => ({
  object_kind: 'pipeline',
  user: { id: 1, name: 'alice', username: options.actor ?? 'alice' },
  project: { id: Number(PROJECT_ID) },
  object_attributes: {
    id,
    status: 'failed',
    ref: MR_REF,
    sha: options.sha ?? SHA_A,
    created_at: '2026-10-01 10:00:00 UTC',
    finished_at: options.finishedAt ?? '2026-10-01 11:00:00 UTC'
  },
  ...(options.mergeRequest === null
    ? {}
    : {
        merge_request: options.mergeRequest ?? {
          id: 700,
          iid: 7,
          target_project_id: Number(PROJECT_ID),
          source_project_id: Number(PROJECT_ID)
        }
      })
})

describe('forge inbox merge request pipeline context', () => {
  let rig: WorkerRig
  afterEach(() => rig.dispose())

  const drain = () => rig.worker().drainOnce()
  const observeMergeRequest = async () => {
    rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
    return drain()
  }
  const failureHook = async (...args: Parameters<typeof pipelineHook>) => {
    rig.admit('pipeline', pipelineHook(...args))
    return drain()
  }
  const tokens = () => rig.revisions().map((row) => String(row.version_token))
  const lastEvent = () => rig.events().at(-1)?.payload

  it('turns an API-verified failure of the already observed head pipeline into a new revision and run', async () => {
    rig = createWorkerRig()
    rig.gitlab.state.headPipeline = headPipeline(100, 'running')
    await observeMergeRequest()
    rig.gitlab.state.headPipeline = headPipeline(100, 'failed')

    await failureHook(100)

    expect(rig.revisions()).toHaveLength(2)
    expect(rig.runs().map((run) => run.state)).toEqual(['superseded', 'queued'])
    expect(lastEvent()).toMatchObject({
      category: 'pipeline-failure',
      pipeline: {
        observed: { id: 100, status: 'failed', sha: SHA_A, ref: MR_REF },
        reported: { id: 100, sha: SHA_A }
      }
    })
  })

  it('ignores delivery-id and timestamp churn of the same failed pipeline', async () => {
    rig = createWorkerRig()
    rig.gitlab.state.headPipeline = headPipeline(100, 'running')
    await observeMergeRequest()
    rig.gitlab.state.headPipeline = headPipeline(100, 'failed')
    await failureHook(100)
    expect(rig.revisions()).toHaveLength(2)

    rig.gitlab.state.headPipeline = headPipeline(100, 'failed', SHA_A, '2026-10-02T08:00:00Z')
    rig.gitlab.state.mergeRequest.updated_at = '2026-10-02T08:00:00.000Z'
    await failureHook(100, { finishedAt: '2026-10-02 08:00:00 UTC' })

    expect(rig.revisions()).toHaveLength(2)
    expect(rig.runs().map((run) => run.state)).toEqual(['superseded', 'queued'])
  })

  it('keeps the verified pipeline facts across a later ordinary merge request hook', async () => {
    rig = createWorkerRig()
    rig.gitlab.state.headPipeline = headPipeline(100, 'running')
    await observeMergeRequest()
    rig.gitlab.state.headPipeline = headPipeline(100, 'failed')
    await failureHook(100)
    const failedTokens = tokens()

    await observeMergeRequest()

    expect(failedTokens).toHaveLength(2)
    expect(tokens()).toEqual(failedTokens)
    expect(rig.runs().map((run) => run.state)).toEqual(['superseded', 'queued'])
  })

  it('treats a different failed pipeline on the same source SHA as new attention', async () => {
    rig = createWorkerRig()
    rig.gitlab.state.headPipeline = headPipeline(100, 'failed')
    await observeMergeRequest()
    await failureHook(100)
    const before = tokens()

    rig.gitlab.state.headPipeline = headPipeline(101, 'failed')
    await failureHook(101)

    expect(tokens()).toHaveLength(before.length + 1)
    expect(lastEvent()).toMatchObject({
      pipeline: { observed: { id: 101, status: 'failed' }, reported: { id: 101 } }
    })
  })

  it('never rolls the context back to a late hook for an older pipeline', async () => {
    rig = createWorkerRig()
    rig.gitlab.state.headPipeline = headPipeline(101, 'failed')
    await observeMergeRequest()
    await failureHook(101)
    const before = tokens()

    await failureHook(100, { finishedAt: '2026-09-30 08:00:00 UTC' })

    expect(tokens()).toEqual(before)
    expect(rig.runs().filter((run) => run.state === 'queued')).toHaveLength(1)
    expect(lastEvent()).toMatchObject({
      pipeline: { observed: { id: 101, status: 'failed' }, reported: { id: 100 } }
    })
  })

  it('does not present a hook-only failure as the current pipeline when the API says otherwise', async () => {
    rig = createWorkerRig()
    rig.gitlab.state.headPipeline = headPipeline(100, 'running')
    await observeMergeRequest()

    await failureHook(999)

    expect(rig.revisions()).toHaveLength(1)
    expect(rig.runs()).toHaveLength(1)
    expect(lastEvent()).toMatchObject({
      pipeline: { observed: { id: 100, status: 'running' }, reported: { id: 999 } }
    })
  })

  it('accepts a merged-result pipeline whose SHA differs from the merge request SHA', async () => {
    rig = createWorkerRig()
    rig.gitlab.state.headPipeline = headPipeline(100, 'running')
    await observeMergeRequest()
    rig.gitlab.state.headPipeline = headPipeline(100, 'failed', SHA_MERGED)

    await failureHook(100, { sha: SHA_MERGED })

    expect(rig.revisions()).toHaveLength(2)
    expect(lastEvent()).toMatchObject({
      pipeline: { observed: { id: 100, sha: SHA_MERGED }, reported: { sha: SHA_MERGED } }
    })
  })

  it('retains the delivery for a bounded retry when the API has no head pipeline yet', async () => {
    rig = createWorkerRig()
    rig.gitlab.state.headPipeline = null
    await observeMergeRequest()
    const events = rig.events().length

    const result = await failureHook(100)

    expect(result).toMatchObject({ retry: 1, done: 0 })
    expect(rig.deliveries().at(-1)).toMatchObject({ last_error_code: 'ci-unavailable' })
    expect(Number(rig.deliveries().at(-1)?.body_bytes)).toBeGreaterThan(0)
    expect(rig.revisions()).toHaveLength(1)
    expect(rig.runs()).toHaveLength(1)
    expect(rig.events()).toHaveLength(events)
  })

  it('retries instead of claiming CI when the response has no CI visibility at all', async () => {
    rig = createWorkerRig()
    await observeMergeRequest()

    await failureHook(100)

    expect(rig.deliveries().at(-1)).toMatchObject({ last_error_code: 'ci-unavailable' })
    expect(rig.runs()).toHaveLength(1)
  })

  it('still reviews an ordinary merge request without CI data', async () => {
    rig = createWorkerRig()

    const result = await observeMergeRequest()

    expect(result).toMatchObject({ done: 1 })
    expect(rig.runs()).toEqual([{ state: 'queued', revision: 1 }])
  })

  it('does not read a same-numbered merge request for a pipeline targeting another project', async () => {
    rig = createWorkerRig()
    const foreign = {
      id: 701,
      iid: 7,
      target_project_id: OTHER_PROJECT,
      source_project_id: Number(PROJECT_ID)
    }

    await failureHook(100, { mergeRequest: foreign })

    expect(rig.gitlab.requests).not.toContain('/merge_requests/7')
    expect(rig.items().filter((item) => item.kind === 'merge_request')).toEqual([])
  })

  it('falls back to the standalone pipeline for the configured actor of a foreign target', async () => {
    rig = createWorkerRig()
    const foreign = {
      id: 701,
      iid: 7,
      target_project_id: OTHER_PROJECT,
      source_project_id: Number(PROJECT_ID)
    }

    await failureHook(9, { actor: 'me', mergeRequest: foreign })

    expect(rig.gitlab.requests).toEqual(['/pipelines/9'])
    expect(rig.items()).toMatchObject([{ kind: 'pipeline', iid: 9 }])
  })

  it('records a recovered API pipeline as passive history without a failure run', async () => {
    rig = createWorkerRig()
    rig.gitlab.state.headPipeline = headPipeline(100, 'running')
    await observeMergeRequest()
    rig.gitlab.state.headPipeline = headPipeline(100, 'success')

    await failureHook(100)

    expect(rig.revisions()).toHaveLength(2)
    expect(rig.runs()).toEqual([{ state: 'queued', revision: 1 }])
    const payload = lastEvent()
    expect(payload).toMatchObject({
      passive: true,
      pipeline: { observed: { id: 100, status: 'success' }, reported: { id: 100 } }
    })
    expect(payload).not.toHaveProperty('category')
  })

  it('lets the next active observation of a passive head queue its first analysis', async () => {
    rig = createWorkerRig()
    rig.gitlab.state.headPipeline = headPipeline(100, 'running')
    await observeMergeRequest()
    rig.gitlab.state.headPipeline = headPipeline(100, 'success')
    await failureHook(100)
    expect(rig.runs()).toEqual([{ state: 'queued', revision: 1 }])

    await observeMergeRequest()

    expect(rig.runs()).toEqual([
      { state: 'superseded', revision: 1 },
      { state: 'queued', revision: 2 }
    ])
  })

  it('queues once when automatic analysis is enabled after the context was observed', async () => {
    rig = createWorkerRig({ project: { automaticAnalysis: false } })
    await observeMergeRequest()
    expect(rig.runs()).toEqual([])
    rig.reconfigure({ automaticAnalysis: true })

    await observeMergeRequest()
    const [queued] = rig.runs()
    await observeMergeRequest()

    expect(queued).toEqual({ state: 'queued', revision: 1 })
    expect(rig.runs()).toEqual([queued])
  })

  describe('standalone pipelines', () => {
    const foreign = {
      id: 701,
      iid: 7,
      target_project_id: OTHER_PROJECT,
      source_project_id: Number(PROJECT_ID)
    }

    it('keeps a confirmed standalone failure as attention with observed facts', async () => {
      rig = createWorkerRig()
      rig.gitlab.state.pipeline = { id: 9, status: 'failed', sha: SHA_A, ref: MR_REF }

      await failureHook(9, { actor: 'me', mergeRequest: null })

      expect(rig.runs()).toEqual([{ state: 'queued', revision: 1 }])
      expect(lastEvent()).toMatchObject({
        category: 'pipeline-failure',
        passive: false,
        pipeline: {
          observed: { id: 9, status: 'failed', sha: SHA_A, ref: MR_REF },
          reported: { id: 9 }
        }
      })
    })

    it.each(['running', 'success'])(
      'records a %s standalone pipeline as passive history without a failure run',
      async (status) => {
        rig = createWorkerRig()
        rig.gitlab.state.pipeline = { id: 9, status, sha: SHA_A, ref: MR_REF }

        await failureHook(9, { actor: 'me', mergeRequest: null })

        expect(rig.gitlab.requests).toEqual(['/pipelines/9'])
        expect(rig.runs()).toEqual([])
        const payload = lastEvent()
        expect(payload).toMatchObject({
          passive: true,
          pipeline: { observed: { id: 9, status, sha: SHA_A, ref: MR_REF }, reported: { id: 9 } }
        })
        expect(payload).not.toHaveProperty('category')
      }
    )

    it('applies the same passive rule to the standalone fallback of a foreign merge request', async () => {
      rig = createWorkerRig()
      rig.gitlab.state.pipeline = { id: 9, status: 'success', sha: SHA_A, ref: MR_REF }

      await failureHook(9, { actor: 'me', mergeRequest: foreign })

      expect(rig.gitlab.requests).toEqual(['/pipelines/9'])
      expect(rig.runs()).toEqual([])
      expect(lastEvent()).toMatchObject({
        passive: true,
        pipeline: { observed: { id: 9, status: 'success' } }
      })
    })
  })
})

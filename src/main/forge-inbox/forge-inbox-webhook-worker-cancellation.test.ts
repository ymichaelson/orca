import { afterEach, describe, expect, it } from 'vitest'
import { createForgeWebhookWorker } from './forge-inbox-webhook-worker'
import {
  createWorkerRig,
  mergeRequestHookBody,
  type WorkerRig
} from './forge-inbox-webhook-worker-test-kit'

const ZERO = { processed: 1, done: 0, failed: 0, needsAuth: 0, retry: 0 }

describe('forge inbox webhook worker cancellation', () => {
  let rig: WorkerRig
  afterEach(() => rig.dispose())

  const workerWith = (signal: AbortSignal, onFetch?: (init?: RequestInit) => Promise<void>) =>
    createForgeWebhookWorker({
      ledger: rig.ledger,
      signal,
      http: {
        fetch: async (url, init) => {
          await onFetch?.(init)
          return rig.gitlab.fetch(url)
        }
      }
    })

  it('claims nothing once cancelled', async () => {
    rig = createWorkerRig()
    rig.admit('merge_request', mergeRequestHookBody())

    const result = await workerWith(AbortSignal.abort()).drainOnce()

    expect(result).toMatchObject({ processed: 0 })
    expect(rig.deliveries()).toMatchObject([{ state: 'pending', attempts: 0 }])
  })

  it('aborts in-flight API work and leaves the claimed row pending under its durable lease', async () => {
    rig = createWorkerRig()
    rig.admit('merge_request', mergeRequestHookBody())
    const controller = new AbortController()
    const worker = workerWith(controller.signal, (init) => {
      controller.abort()
      return new Promise<void>((_resolve, reject) => {
        const cancelledByOwner = () =>
          init?.signal?.reason instanceof DOMException && init.signal.reason.name === 'AbortError'
        if (init?.signal?.aborted && cancelledByOwner()) {
          reject(new DOMException('aborted', 'AbortError'))
        }
        init?.signal?.addEventListener('abort', () => {
          if (cancelledByOwner()) {
            reject(new DOMException('aborted', 'AbortError'))
          }
        })
      })
    })

    await worker.drainOnce()

    const [row] = rig.deliveries()
    expect(row).toMatchObject({ state: 'pending', attempts: 1 })
    expect(row.next_attempt_at).not.toBeNull()
    expect(row.last_error_code).toBeNull()
    expect(rig.items()).toEqual([])
  })

  it('does not ingest a snapshot that finished after cancellation', async () => {
    rig = createWorkerRig()
    rig.admit('merge_request', mergeRequestHookBody())
    const controller = new AbortController()
    let requests = 0
    rig.gitlab.state.onRequest = () => {
      requests += 1
      if (requests === 4) {
        controller.abort()
      }
    }

    await workerWith(controller.signal).drainOnce()

    expect(rig.gitlab.requests).toHaveLength(4)
    expect(rig.items()).toEqual([])
    expect(rig.runs()).toEqual([])
    expect(rig.deliveries()).toMatchObject([{ state: 'pending', attempts: 1 }])
  })

  describe('rejected state transitions are not counted as outcomes', () => {
    it.each([
      ['done', () => undefined],
      ['needs-auth', () => ({ forced: 401 })],
      ['retry', () => ({ forced: 500 })]
    ] as const)(
      'when the %s outcome is refused by a row finished elsewhere',
      async (_label, mode) => {
        rig = createWorkerRig()
        const id = rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['bob'] }))
        const forced = mode()
        rig.gitlab.state.onRequest = () => {
          rig.ledger.markWebhookDeliveryFailed(id, { code: 'finished-elsewhere', terminal: true })
        }
        if (forced) {
          rig.gitlab.state.override = () => new Response('{}', { status: forced.forced })
        }

        await expect(rig.worker().drainOnce()).resolves.toEqual(ZERO)

        expect(rig.deliveries()).toMatchObject([
          { state: 'failed', last_error_code: 'finished-elsewhere' }
        ])
      }
    )
  })
})

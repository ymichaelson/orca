import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { issueHookBody, mergeRequestHookBody, SHA_B } from './forge-inbox-gitlab-fake-server'
import {
  createOwnerFixture,
  freePort,
  listenerOn,
  postHook,
  provision,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'
import { INSTANCE_ID } from './forge-inbox-webhook-test-harness'

type Published = { ownerId: string; itemId: number; reason: string; eventId?: number }

describe('forge inbox owner notification producer', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  const mergeRequest = (sha?: string) =>
    mergeRequestHookBody({ reviewers: ['me'], ...(sha ? { sha } : {}) })

  function apiMovesTo(sha: string): void {
    fx.gitlab.state.mergeRequest.sha = sha
    fx.gitlab.state.mergeRequest.updated_at = '2026-10-02T12:00:00.000Z'
  }

  async function startOwner(sinks: ((n: Published) => void)[]) {
    const port = await freePort()
    const service = fx.service({ notificationSinks: sinks })
    await service.start()
    await provision(service, listenerOn(port))
    return { service, port }
  }

  it('creates no database, journal or processor work for an owner that never configured anything', async () => {
    fx = createOwnerFixture()
    const sink = vi.fn()
    const service = fx.service({ notificationSinks: [sink] })
    await service.start()
    await service.settled()

    expect(service.status()).toMatchObject({ dormant: true, running: false })
    expect(existsSync(fx.dbPath)).toBe(false)
    expect(existsSync(`${fx.dbPath}-wal`)).toBe(false)
    expect(sink).not.toHaveBeenCalled()
    await service.stop()
  })

  it('publishes a webhook-driven review request once and not again after a restart or a new message id', async () => {
    fx = createOwnerFixture()
    const published: Published[] = []
    const { service, port } = await startOwner([(n) => published.push(n)])

    await postHook(port, mergeRequest(), 'm-1')
    await service.settled()
    await vi.waitFor(() => expect(published).toHaveLength(1))
    expect(published[0]).toMatchObject({
      ownerId: service.ownerHostId(),
      reason: 'review-request'
    })

    await postHook(port, mergeRequest(), 'm-2')
    await service.settled()
    await service.stop()

    const restarted = fx.service({ notificationSinks: [(n) => published.push(n)] })
    await restarted.start()
    await restarted.settled()
    await restarted.stop()
    expect(published).toHaveLength(1)
  })

  it('does not alert for a hook-reported new commit the API does not confirm', async () => {
    fx = createOwnerFixture()
    const published: Published[] = []
    const { service, port } = await startOwner([(n) => published.push(n)])
    await postHook(port, mergeRequest(), 'm-1')
    await service.settled()
    await vi.waitFor(() => expect(published).toHaveLength(1))

    await postHook(port, mergeRequest(SHA_B), 'm-2')
    await service.settled()

    expect(published).toHaveLength(1)
  })

  it('does not treat claim, read or cursor hints as attention', async () => {
    fx = createOwnerFixture()
    const published: Published[] = []
    const { service, port } = await startOwner([(n) => published.push(n)])
    await postHook(port, mergeRequest(), 'm-1')
    await service.settled()
    await vi.waitFor(() => expect(published).toHaveLength(1))
    const [{ itemId }] = published

    await service.ackClientCursor({ instanceId: INSTANCE_ID, readerId: 'reader', seq: 1 })
    service.markRead({ instanceId: INSTANCE_ID }, { clientId: 'reader', itemId })
    await service.settled()

    expect(published).toHaveLength(1)
  })

  it('keeps publishing to other sinks and later news after one sink throws, logging no values', async () => {
    fx = createOwnerFixture()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const good: Published[] = []
    const { service, port } = await startOwner([
      () => {
        throw new Error('sink secret-value-12345')
      },
      (n) => good.push(n)
    ])

    await postHook(port, mergeRequest(), 'm-1')
    await service.settled()
    await vi.waitFor(() => expect(good).toHaveLength(1))
    apiMovesTo(SHA_B)
    await postHook(port, mergeRequest(SHA_B), 'm-2')
    await service.settled()
    await vi.waitFor(() => expect(good).toHaveLength(2))

    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain('secret-value-12345')
    warn.mockRestore()
  })

  it('publishes nothing after stop begins and closes the ledger only after the processor settled', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const first = fx.service()
    await first.start()
    await provision(first, listenerOn(port))
    await postHook(port, mergeRequest(), 'm-1')
    await postHook(port, issueHookBody({ assignees: ['me'] }), 'i-1', undefined, 'Issue Hook')
    await first.settled()
    await first.stop()
    expect(fx.rows('SELECT kind FROM items ORDER BY kind')).toEqual([
      { kind: 'issue' },
      { kind: 'merge_request' }
    ])

    const published: Published[] = []
    let stopping: Promise<void> | null = null
    const second = fx.service({
      notificationSinks: [
        (n) => {
          published.push(n)
          stopping ??= second.stop()
        }
      ]
    })
    await second.start()
    await stopping
    await expect(second.stop()).resolves.toBeUndefined()

    expect(published).toHaveLength(1)
  })
})

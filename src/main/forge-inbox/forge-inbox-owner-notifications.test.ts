import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectEventDecisionResult } from '../../shared/project-event-decision'
import { issueHookBody, mergeRequestHookBody, SHA_B } from './forge-inbox-gitlab-fake-server'
import {
  createOwnerFixture,
  freePort,
  listenerOn,
  postHook,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'

type Published = {
  ownerId: string
  instanceId: string
  itemId: number
  reason: string
  eventId?: number
}

const notifyDecision = (): ProjectEventDecisionResult => ({
  ok: true,
  provider: 'jev',
  model: 'jev-1',
  action: 'notify',
  confidence: 0.8,
  probabilities: {
    record_only: 0.04,
    notify: 0.8,
    wait: 0.04,
    fetch_context: 0.04,
    dispatch_agent: 0.04,
    ask_user: 0.04
  },
  usage: { inputTokens: 10, outputTokens: 2 }
})

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
    const service = fx.service({
      notificationSinks: sinks,
      decideProjectEvent: async () => notifyDecision()
    })
    await service.start()
    await fx.provision(service, listenerOn(port))
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

  it('publishes a webhook-driven merge request update once and not again after a restart', async () => {
    fx = createOwnerFixture()
    const published: Published[] = []
    const { service, port } = await startOwner([(n) => published.push(n)])

    await postHook(port, mergeRequest(), 'm-1')
    await service.settled()
    await vi.waitFor(() => expect(published).toHaveLength(1))
    expect(published[0]).toMatchObject({
      ownerId: service.ownerHostId(),
      reason: 'participating-update'
    })

    await service.stop()

    const restarted = fx.service({ notificationSinks: [(n) => published.push(n)] })
    await restarted.start()
    await restarted.settled()
    await restarted.stop()
    expect(published).toHaveLength(1)
  })

  it('does not treat claim, read or cursor hints as attention', async () => {
    fx = createOwnerFixture()
    const published: Published[] = []
    const { service, port } = await startOwner([(n) => published.push(n)])
    await postHook(port, mergeRequest(), 'm-1')
    await service.settled()
    await vi.waitFor(() => expect(published).toHaveLength(1))
    const [{ itemId, instanceId }] = published

    await service.ackClientCursor({ instanceId, readerId: 'reader', seq: 1 })
    service.markRead({ instanceId }, { clientId: 'reader', itemId })
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
    const first = fx.service({ decideProjectEvent: async () => notifyDecision() })
    await first.start()
    await fx.provision(first, listenerOn(port))
    await postHook(port, mergeRequest(), 'm-1')
    const issue = issueHookBody({ assignees: ['me'] })
    issue.object_attributes.action = 'assign'
    await postHook(port, issue, 'i-1', undefined, 'Issue Hook')
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

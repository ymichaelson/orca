import { existsSync } from 'node:fs'
import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeRequestHookBody } from './forge-inbox-gitlab-fake-server'
import { ForgeInboxOwnerNotRunningError } from './forge-inbox-owner-errors'
import {
  connectRefused,
  createOwnerFixture,
  freePort,
  holdRequestMidBody,
  listenerOn,
  ownerConfig,
  postHook,
  provision,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
// Failure bound only: every awaited barrier is an event, never a delay the test depends on.
const BOUND_MS = 3_000

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), BOUND_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function untilRefused(port: number): Promise<void> {
  const deadline = performance.now() + BOUND_MS
  while (!(await connectRefused(port))) {
    if (performance.now() > deadline) {
      throw new Error(`port ${port} never stopped accepting`)
    }
    await tick()
  }
}

/** Wraps (and calls through) the real server bind so a test can see which ports were requested. */
function spyOnBinds() {
  const spy = vi.spyOn(net.Server.prototype, 'listen')
  return {
    mark: () => spy.mock.calls.length,
    portsSince(mark: number): number[] {
      return spy.mock.calls.slice(mark).flatMap(([target]) => {
        return typeof target === 'object' && target !== null && 'port' in target
          ? [Number(target.port)]
          : []
      })
    }
  }
}

const SLOW_CLOSE = { requestDeadlineMs: 30_000, shutdownGraceMs: 20_000 }

describe('forge inbox owner service stop while a request holds the listener open', () => {
  let fx: OwnerFixture
  afterEach(async () => {
    vi.restoreAllMocks()
    await fx.dispose()
  })

  async function withWorkerAndHeldRequest() {
    fx = createOwnerFixture()
    const portA = await freePort()
    const service = fx.service({ ingress: SLOW_CLOSE })
    await service.start()
    await provision(service, listenerOn(portA))
    fx.gate.hold()
    await postHook(portA, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await within(fx.gate.requestBlocked(), 'worker request reached the API')
    const held = await within(holdRequestMidBody(portA, 'm-held'), 'held request in flight')
    return { service, portA, held }
  }

  it('cancels the worker while the body is still held, keeps the ledger open, then closes it once', async () => {
    const { service, held } = await withWorkerAndHeldRequest()
    try {
      let stopped = false
      const stopping = service.stop().then(() => (stopped = true))
      await within(fx.gate.abortObserved(), 'worker abort before the held body is released')

      expect(stopped).toBe(false)
      expect(existsSync(`${fx.dbPath}-wal`)).toBe(true)

      held.release()
      await within(stopping, 'stop after the held body is released')
    } finally {
      held.release()
    }
    expect(existsSync(`${fx.dbPath}-wal`)).toBe(false)
    const reopened = fx.service()
    await reopened.start()
    expect(reopened.getConfig().config.listener.enabled).toBe(true)
  })

  it('cancels the worker during a listener reconcile and never binds the replacement port', async () => {
    const { service, portA, held } = await withWorkerAndHeldRequest()
    const portB = await freePort()
    try {
      const updating = service.updateConfig(
        service.getConfig().configRevision,
        ownerConfig(listenerOn(portB))
      )
      await untilRefused(portA)
      const binds = spyOnBinds()
      const mark = binds.mark()

      const stopping = service.stop()
      await within(fx.gate.abortObserved(), 'worker abort while the reconcile is blocked')
      expect(await connectRefused(portB)).toBe(true)

      held.release()
      await within(Promise.all([updating, stopping]), 'reconcile and stop settle')
      expect(await updating).toMatchObject({ ok: true })

      expect(binds.portsSince(mark)).toEqual([])
      expect(await connectRefused(portB)).toBe(true)
      expect(existsSync(`${fx.dbPath}-wal`)).toBe(false)
    } finally {
      held.release()
    }
  })

  it('keeps every queued or late config change from opening a port once stop was requested', async () => {
    const { service, portA, held } = await withWorkerAndHeldRequest()
    const [portB, portC, portD] = [await freePort(), await freePort(), await freePort()]
    try {
      const first = service.updateConfig(
        service.getConfig().configRevision,
        ownerConfig(listenerOn(portB))
      )
      const second = service.updateConfig(
        service.getConfig().configRevision,
        ownerConfig(listenerOn(portC))
      )
      await untilRefused(portA)
      const binds = spyOnBinds()
      const mark = binds.mark()

      const lateRevision = service.getConfig().configRevision
      const stopping = service.stop()
      await expect(
        service.updateConfig(lateRevision, ownerConfig(listenerOn(portD)))
      ).rejects.toBeInstanceOf(ForgeInboxOwnerNotRunningError)

      held.release()
      await within(Promise.all([first, second, stopping]), 'queued reconciles and stop settle')
      expect([await first, await second]).toMatchObject([{ ok: true }, { ok: true }])

      expect(binds.portsSince(mark)).toEqual([])
      expect(existsSync(`${fx.dbPath}-wal`)).toBe(false)
    } finally {
      held.release()
    }
  })
})

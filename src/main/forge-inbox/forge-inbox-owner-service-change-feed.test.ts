import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeRequestHookBody } from './forge-inbox-gitlab-fake-server'
import {
  ForgeInboxInvalidCursorError,
  ForgeInboxOwnerMismatchError,
  ForgeInboxOwnerNotRunningError
} from './forge-inbox-owner-errors'
import {
  createOwnerFixture,
  freePort,
  listenerOn,
  postHook,
  provision,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeOwnerChangeHint } from './forge-inbox-owner-hints'
import { INSTANCE_ID } from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('forge inbox owner service change feed', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  async function ingestOne(service: ReturnType<OwnerFixture['service']>, id = 'm-1') {
    const port = await freePort()
    await provision(service, listenerOn(port))
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), id)
    await service.settled()
  }

  describe('commit hints', () => {
    it('lets a dormant subscriber attach without a file and hear the first-use commits', async () => {
      fx = createOwnerFixture()
      const service = fx.service()
      await service.start()
      const hints: ForgeOwnerChangeHint[] = []

      service.subscribeChangeHints((hint) => hints.push(hint))
      expect(existsSync(fx.dbPath)).toBe(false)

      await ingestOne(service)
      await settle()

      const owner = service.ownerHostId()
      expect(hints.length).toBeGreaterThan(0)
      expect(hints.every((hint) => hint.kind === 'committed' && hint.ownerHostId === owner)).toBe(
        true
      )
      expect(hints).toContainEqual({
        kind: 'committed',
        ownerHostId: owner,
        changes: false,
        readClientIds: []
      })
      expect(hints).toContainEqual({
        kind: 'committed',
        ownerHostId: owner,
        changes: true,
        readClientIds: []
      })
    })

    it('ends subscribers on stop, delivers nothing afterwards and refuses new subscriptions', async () => {
      fx = createOwnerFixture()
      const service = fx.service()
      await service.start()
      await ingestOne(service)
      const hints: unknown[] = []
      const unsubscribe = service.subscribeChangeHints((hint) => hints.push(hint))

      await service.stop()
      await settle()

      expect(hints).toEqual([{ kind: 'ended', reason: 'stopped' }])
      unsubscribe()
      unsubscribe()
      expect(() => service.subscribeChangeHints(() => undefined)).toThrow(
        ForgeInboxOwnerNotRunningError
      )
    })

    it('gives nothing to a listener unsubscribed by an earlier listener during the same dispatch', async () => {
      fx = createOwnerFixture()
      const service = fx.service()
      await service.start()
      const received: ForgeOwnerChangeHint[] = []
      let unsubscribeSecond: () => void = () => undefined
      service.subscribeChangeHints(() => unsubscribeSecond())
      unsubscribeSecond = service.subscribeChangeHints((hint) => received.push(hint))

      await ingestOne(service)
      await settle()

      expect(received).toEqual([])
    })

    it('does not deliver a later unsubscribed or throwing listener into write failures', async () => {
      fx = createOwnerFixture()
      const service = fx.service()
      await service.start()
      const survivor: unknown[] = []
      service.subscribeChangeHints(() => {
        throw new Error('listener bug')
      })
      service.subscribeChangeHints((hint) => survivor.push(hint))
      const gone: unknown[] = []
      service.subscribeChangeHints((hint) => gone.push(hint))()

      await ingestOne(service)
      await settle()

      expect(survivor.length).toBeGreaterThan(0)
      expect(gone).toEqual([])
    })

    it('ends the subscription instead of retargeting it when another owner appears', async () => {
      fx = createOwnerFixture()
      const service = fx.service()
      await service.start()
      const dormantOwner = service.ownerHostId()
      const hints: unknown[] = []
      service.subscribeChangeHints((hint) => hints.push(hint))
      ForgeInboxLedger.open(fx.dbPath, { hostId: 'another-owner', secretStore: fx.store }).close()

      await expect(
        service.updateConfig(0, { schemaVersion: 1, listener: {}, instances: [] }, dormantOwner)
      ).rejects.toThrow(ForgeInboxOwnerMismatchError)
      await settle()
      await service.updateConfig(service.getConfig().configRevision, {
        schemaVersion: 1,
        listener: {},
        instances: []
      })
      await settle()

      expect(hints).toEqual([{ kind: 'ended', reason: 'owner-changed' }])
    })
  })

  describe('cursors', () => {
    it('answers head and cursor 0 and accepts ack 0 for a dormant host without a file', async () => {
      fx = createOwnerFixture()
      const service = fx.service()
      await service.start()

      expect(service.readChangeHead(SCOPE)).toBe(0)
      expect(service.getClientCursor({ ...SCOPE, readerId: 'r1' })).toBe(0)
      await expect(service.ackClientCursor({ ...SCOPE, readerId: 'r1', seq: 0 })).resolves.toBe(0)
      await expect(service.ackClientCursor({ ...SCOPE, readerId: 'r1', seq: 1 })).rejects.toThrow(
        ForgeInboxInvalidCursorError
      )

      expect(existsSync(fx.dbPath)).toBe(false)
    })

    it('rejects unsafe or future sequences before writing and acks monotonically per reader and scope', async () => {
      fx = createOwnerFixture()
      const service = fx.service()
      await service.start()
      await ingestOne(service)
      const head = service.readChangeHead(SCOPE)
      expect(head).toBeGreaterThan(0)

      for (const seq of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, head + 1]) {
        await expect(service.ackClientCursor({ ...SCOPE, readerId: 'r1', seq })).rejects.toThrow(
          ForgeInboxInvalidCursorError
        )
      }
      expect(service.getClientCursor({ ...SCOPE, readerId: 'r1' })).toBe(0)

      await expect(service.ackClientCursor({ ...SCOPE, readerId: 'r1', seq: head })).resolves.toBe(
        head
      )
      await expect(service.ackClientCursor({ ...SCOPE, readerId: 'r1', seq: 1 })).resolves.toBe(
        head
      )
      expect(service.getClientCursor({ ...SCOPE, readerId: 'r1' })).toBe(head)
      expect(service.getClientCursor({ ...SCOPE, readerId: 'r2' })).toBe(0)
      expect(service.getClientCursor({ readerId: 'r1' })).toBe(0)
      expect(service.getClientCursor({ instanceId: 'other', readerId: 'r1' })).toBe(0)
    })

    it('keeps the cursor across reopen and never marks items read or moves the feed', async () => {
      fx = createOwnerFixture()
      const first = fx.service()
      await first.start()
      await ingestOne(first)
      const head = first.readChangeHead(SCOPE)
      const feed = first.listChanges(SCOPE, { afterSeq: 0 })
      const unreadBefore = first.listItems({ ...SCOPE, clientId: 'r1' }).rows[0].unread

      await first.ackClientCursor({ ...SCOPE, readerId: 'r1', seq: head })
      expect(first.listChanges(SCOPE, { afterSeq: 0 })).toEqual(feed)
      expect(first.listItems({ ...SCOPE, clientId: 'r1' }).rows[0].unread).toBe(unreadBefore)
      await first.stop()

      const second = fx.service()
      await second.start()
      expect(second.getClientCursor({ ...SCOPE, readerId: 'r1' })).toBe(head)
      expect(second.readChangeHead(SCOPE)).toBe(head)
    })

    it('refuses cursor operations once stopped', async () => {
      fx = createOwnerFixture()
      const service = fx.service()
      await service.start()
      await service.stop()

      expect(() => service.readChangeHead(SCOPE)).toThrow(ForgeInboxOwnerNotRunningError)
      await expect(service.ackClientCursor({ ...SCOPE, readerId: 'r1', seq: 0 })).rejects.toThrow(
        ForgeInboxOwnerNotRunningError
      )
    })
  })

  describe('project policy', () => {
    it('applies a patch after the owner fence and wakes subscribers only for the successful write', async () => {
      fx = createOwnerFixture()
      const service = fx.service()
      await service.start()
      await ingestOne(service)
      const hints: unknown[] = []
      service.subscribeChangeHints((hint) => hints.push(hint))
      const target = { instanceId: INSTANCE_ID, projectId: '42' }
      const owner = service.ownerHostId()

      const stale = await service.updateProjectPolicy(
        service.getConfig().configRevision - 1,
        { ...target, patch: { rules: 'x' } },
        owner
      )
      await settle()
      expect(stale).toMatchObject({ ok: false, reason: 'stale-revision' })
      expect(hints).toEqual([])

      await expect(
        service.updateProjectPolicy(
          service.getConfig().configRevision,
          { ...target, patch: { rules: 'x' } },
          'someone-else'
        )
      ).rejects.toThrow(ForgeInboxOwnerMismatchError)
      expect(service.getConfig().config.instances[0].projects[0].rules).toBe('')

      const ok = await service.updateProjectPolicy(
        service.getConfig().configRevision,
        { ...target, patch: { rules: 'x' } },
        owner
      )
      await settle()
      expect(ok).toMatchObject({ ok: true })
      expect(service.getConfig().config.instances[0].projects[0].rules).toBe('x')
      expect(hints).toHaveLength(1)
    })
  })
})

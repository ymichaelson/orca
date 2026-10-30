import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ForgeInboxOwnerNotRunningError } from './forge-inbox-owner-errors'
import {
  connectRefused,
  createOwnerFixture,
  freePort,
  listenerOn,
  ownerConfig,
  seedLedger,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'

const ledgerFiles = (fx: OwnerFixture) =>
  ['', '-wal', '-shm'].map((suffix) => existsSync(`${fx.dbPath}${suffix}`))

describe('forge inbox owner service with no ledger file', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  it('creates nothing and opens nothing on start, status, idle or stop', async () => {
    fx = createOwnerFixture()
    const service = fx.service()
    await service.start()

    expect(service.idle()).toBe(true)
    expect(service.status()).toMatchObject({
      phase: 'running',
      listener: { enabled: false, listening: false },
      work: { pending: 0, needsAuth: 0, draining: false }
    })
    await service.settled()
    await service.stop()

    expect(ledgerFiles(fx)).toEqual([false, false, false])
  })

  it('answers the default configuration without creating the file', async () => {
    fx = createOwnerFixture()
    const service = fx.service()
    await service.start()

    expect(service.getConfig()).toMatchObject({
      configRevision: 0,
      config: { listener: { enabled: false }, instances: [] },
      credentials: []
    })
    expect(ledgerFiles(fx)).toEqual([false, false, false])
  })

  it('opens on the first config write without enabling the global receiver and keeps the same host id', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()
    const before = service.getConfig()

    const result = await service.updateConfig(before.configRevision, ownerConfig(listenerOn(port)))

    expect(result.ok).toBe(true)
    expect(existsSync(fx.dbPath)).toBe(true)
    expect(service.status().listener).toMatchObject({ enabled: false, listening: false })
    expect(await connectRefused(port)).toBe(true)
    expect(service.getConfig().hostId).toBe(before.hostId)
  })

  it('opens on the first credential write', async () => {
    fx = createOwnerFixture()
    const service = fx.service()
    await service.start()

    await service.setCredential({
      instanceId: 'no-such-instance',
      kind: 'webhook',
      secret: 'x',
      expectedRevision: 0
    })

    expect(existsSync(fx.dbPath)).toBe(true)
  })

  it('shares one open between concurrent first writes', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()

    const [a, b] = await Promise.all([
      service.updateConfig(0, ownerConfig(listenerOn(port))),
      service.updateConfig(0, ownerConfig(listenerOn(port)))
    ])

    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect(service.status().listener.listening).toBe(false)
    expect(await connectRefused(port)).toBe(true)
  })

  it('leaves no file or listener when a stop lands during the first open', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()

    const writing = service.updateConfig(0, ownerConfig(listenerOn(port))).catch((error) => error)
    const stopping = service.stop()
    const outcome = await writing
    await stopping

    expect(outcome === undefined || outcome.ok === true || outcome instanceof Error).toBe(true)
    expect(await connectRefused(port)).toBe(true)
    expect(existsSync(`${fx.dbPath}-wal`)).toBe(false)
    expect(service.status().running).toBe(false)
  })

  it('refuses a write after stop without ever creating the file', async () => {
    fx = createOwnerFixture()
    const service = fx.service()
    await service.start()
    await service.stop()

    await expect(
      service.updateConfig(0, ownerConfig(listenerOn(await freePort())))
    ).rejects.toBeInstanceOf(ForgeInboxOwnerNotRunningError)
    expect(() => service.getConfig()).toThrow(ForgeInboxOwnerNotRunningError)
    expect(ledgerFiles(fx)).toEqual([false, false, false])
  })

  it('says so while dormant and stops saying so once opened or stopped', async () => {
    fx = createOwnerFixture()
    const service = fx.service()
    expect(service.status().dormant).toBe(false)
    await service.start()
    expect(service.status().dormant).toBe(true)

    await service.updateConfig(0, ownerConfig(listenerOn(await freePort())))
    expect(service.status().dormant).toBe(false)

    const other = fx.service({ dbPath: join(fx.root, 'second.db') })
    await other.start()
    await other.stop()
    expect(other.status().dormant).toBe(false)
  })

  it('rejects a write after a failed first open with the typed error and creates nothing', async () => {
    fx = createOwnerFixture()
    const blocker = join(fx.root, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const service = fx.service({ dbPath: join(blocker, 'forge-inbox.db') })
    await service.start()
    const config = ownerConfig(listenerOn(await freePort()))

    await expect(service.updateConfig(0, config)).rejects.not.toBeInstanceOf(
      ForgeInboxOwnerNotRunningError
    )
    await expect(service.updateConfig(0, config)).rejects.toBeInstanceOf(
      ForgeInboxOwnerNotRunningError
    )
    expect(service.status()).toMatchObject({ running: false, dormant: false })
    expect(existsSync(join(blocker, 'forge-inbox.db'))).toBe(false)
  })

  it('opens a ledger that appeared after start, keeping its owner and refusing a stale first write', async () => {
    fx = createOwnerFixture()
    const service = fx.service()
    await service.start()
    const dormantHost = service.getConfig().hostId
    await seedLedger(fx)
    const [persisted] = fx.rows("SELECT value FROM meta WHERE key = 'host_id'")
    const persistedHost = persisted?.value

    const result = await service.updateConfig(0, ownerConfig(listenerOn(await freePort())))

    expect(result).toMatchObject({ ok: false, reason: 'stale-revision' })
    expect(persistedHost).not.toBe(dormantHost)
    expect(service.getConfig().hostId).toBe(persistedHost)
    expect(service.getConfig().configRevision).toBeGreaterThan(0)
    expect(service.status().listener.enabled).toBe(false)
  })
})

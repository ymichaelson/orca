import { afterEach, describe, expect, it } from 'vitest'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createOwnerFixture,
  seedLedger,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'

describe('forge inbox owner service project event run recovery', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  it('queries the journal on the open ledger once the service starts', async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    const recovered: ForgeInboxLedger[] = []
    const service = fx.service({
      recoverProjectEventRuns: async (ledger) => {
        recovered.push(ledger)
      }
    })

    await service.start()

    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.dbPath).toBe(fx.dbPath)
    expect(service.status()).toMatchObject({ phase: 'running', running: true })
  })

  it('still reaches running when recovery fails', async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    const service = fx.service({
      recoverProjectEventRuns: async () => {
        throw new Error('journal unavailable')
      }
    })

    await expect(service.start()).resolves.toBeUndefined()

    expect(service.status()).toMatchObject({ phase: 'running', running: true })
  })
})

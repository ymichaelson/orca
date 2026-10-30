import { afterEach, describe, expect, it } from 'vitest'
import type { ForgePatchProduceRequest } from './forge-inbox-patch-produce'
import { ForgeInboxOwnerMismatchError } from './forge-inbox-owner-errors'
import { createOwnerFixture, type OwnerFixture } from './forge-inbox-owner-service-test-kit'
import { INSTANCE_ID } from './forge-inbox-webhook-test-harness'

const REQUEST: ForgePatchProduceRequest = {
  scope: { instanceId: INSTANCE_ID },
  callerKey: 'trusted-local:desktop',
  operationId: 'op-1',
  runId: 999,
  message: 'Please update the feature',
  paths: []
}

describe('forge inbox owner service patch proposals', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  it('refuses with host-unavailable when this host has no producer', async () => {
    fx = createOwnerFixture()
    const service = fx.service()
    await service.start()

    await expect(service.proposePatch(REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'refused',
      reason: 'host-unavailable'
    })
    expect(fx.rows('SELECT id FROM patch_requests')).toEqual([])
  })

  it('rejects a caller that addressed another owner', async () => {
    fx = createOwnerFixture()
    const service = fx.service()
    await service.start()

    await expect(
      service.proposePatch(REQUEST, new AbortController().signal, 'another-owner')
    ).rejects.toBeInstanceOf(ForgeInboxOwnerMismatchError)
  })
})

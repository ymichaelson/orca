import { afterEach, describe, expect, it } from 'vitest'
import type { ForgePatchProduceRequest } from './forge-inbox-patch-produce'
import { forgeInboxPatchProducerForRuntime } from './forge-inbox-patch-produce-runtime'
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

  it('passes the request and the caller’s signal to the wired producer', async () => {
    fx = createOwnerFixture()
    const seen: { request: ForgePatchProduceRequest; signal: AbortSignal }[] = []
    const result = { kind: 'proposal', proposalId: 9, requestId: 8 } as const
    const service = fx.service({
      proposePatch: () => async (request, signal) => {
        seen.push({ request, signal })
        return result
      }
    })
    await service.start()
    const signal = new AbortController().signal

    await expect(service.proposePatch(REQUEST, signal)).resolves.toBe(result)
    expect(seen).toEqual([{ request: REQUEST, signal }])
  })

  it('rejects a caller that addressed another owner', async () => {
    fx = createOwnerFixture()
    const service = fx.service()
    await service.start()

    await expect(
      service.proposePatch(REQUEST, new AbortController().signal, 'another-owner')
    ).rejects.toBeInstanceOf(ForgeInboxOwnerMismatchError)
  })

  it('answers an unknown run through the production producer without a host or a fetch', async () => {
    fx = createOwnerFixture()
    const urls: string[] = []
    let hostCalls = 0
    const service = fx.service({
      http: {
        fetch: (url: string, init?: RequestInit) => {
          urls.push(url)
          return fx.gitlab.fetch(url, init)
        }
      },
      proposePatch: forgeInboxPatchProducerForRuntime({
        runtime: {
          ensureStructuredAgentSessionHost: async () => {
            hostCalls += 1
            throw new Error('no structured host in this test')
          }
        },
        http: {
          fetch: (url: string, init?: RequestInit) => {
            urls.push(url)
            return fx.gitlab.fetch(url, init)
          }
        }
      })
    })
    await service.start()

    await expect(service.proposePatch(REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'refused',
      reason: 'run-not-found'
    })
    expect(urls).toEqual([])
    expect(hostCalls).toBe(0)
    expect(fx.rows('SELECT id FROM patch_requests')).toEqual([])
  })
})

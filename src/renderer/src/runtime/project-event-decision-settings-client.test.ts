import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { callProjectEventDecisionSettings } from './project-event-decision-settings-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  runtimeEnvironmentSupportsCapability: vi.fn()
}))
const target = { kind: 'environment' as const, environmentId: 'remote-owner' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runtimeEnvironmentSupportsCapability).mockResolvedValue(true)
  vi.mocked(callRuntimeRpc).mockResolvedValue({ ownerHostId: 'host-id' })
})

describe('decision settings host routing', () => {
  it('sends credentials only to the explicitly selected capable host', async () => {
    await callProjectEventDecisionSettings(target, 'saveApiKey', {
      ownerHostId: 'host-id',
      provider: 'laya',
      apiKey: 'secret'
    })
    expect(runtimeEnvironmentSupportsCapability).toHaveBeenCalledWith(
      'remote-owner',
      'project-events.decision-settings.v1'
    )
    expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
      target,
      'projectEventDecision.saveApiKey',
      { ownerHostId: 'host-id', provider: 'laya', apiKey: 'secret' }
    )
  })

  it('refuses mixed-version missing capability without sending a secret or falling back locally', async () => {
    vi.mocked(runtimeEnvironmentSupportsCapability).mockResolvedValue(false)
    await expect(
      callProjectEventDecisionSettings(target, 'saveApiKey', {
        ownerHostId: 'host-id',
        provider: 'jev',
        apiKey: 'secret'
      })
    ).rejects.toThrow('project_event_decision_unavailable')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sanitizes method absence and backend transport errors without retries or fallback', async () => {
    for (const error of [
      new Error('secret'),
      new RuntimeRpcCallError({
        id: 'a',
        ok: false,
        error: { code: 'method_not_found', message: 'secret' },
        _meta: { runtimeId: 'remote-owner' }
      })
    ]) {
      vi.mocked(callRuntimeRpc).mockRejectedValueOnce(error)
      await expect(
        callProjectEventDecisionSettings(target, 'clearApiKey', {
          ownerHostId: 'host-id',
          provider: 'laya'
        })
      ).rejects.toThrow('project_event_decision_unavailable')
    }
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(vi.mocked(callRuntimeRpc).mock.calls.every(([actual]) => actual === target)).toBe(true)
  })
})

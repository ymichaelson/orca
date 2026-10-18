import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { PersistedTrustedOrcaHooks } from '../../../shared/orca-yaml-hook-types'
import { __resetTrustPromptChainForTests, ensureHooksConfirmed } from './ensure-hooks-confirmed'
import { hashOrcaHookScript } from './orca-hook-trust'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

const hooksCheckMock = vi.fn()
const readIssueCommandMock = vi.fn()
const runtimeEnvironmentCallMock = vi.fn()
const runtimeEnvironmentTransportCallMock = vi.fn()

function installHooksApiMock(): void {
  vi.stubGlobal('window', {
    api: {
      hooks: {
        check: hooksCheckMock,
        readIssueCommand: readIssueCommandMock
      },
      runtimeEnvironments: {
        call: runtimeEnvironmentTransportCallMock
      }
    }
  })
}

type PendingPrompt = {
  modal: string
  data: Record<string, unknown>
  resolve: (decision: 'run' | 'skip') => void
}

function createTestState(overrides?: Partial<Record<keyof AppState, unknown>>): {
  state: AppState
  pending: PendingPrompt[]
} {
  const pending: PendingPrompt[] = []
  const trust: PersistedTrustedOrcaHooks = {}
  const state = {
    trustedOrcaHooks: trust,
    repos: [{ id: 'repo-1', displayName: 'Repo One' }],
    openModal: (modal: string, data: Record<string, unknown>) => {
      pending.push({ modal, data, resolve: data.onResolve as (d: 'run' | 'skip') => void })
    },
    ...overrides
  } as unknown as AppState
  return { state, pending }
}

describe('ensureHooksConfirmed runtime-owner global defaults', () => {
  beforeEach(() => {
    hooksCheckMock.mockReset()
    readIssueCommandMock.mockReset()
    runtimeEnvironmentCallMock.mockReset()
    runtimeEnvironmentTransportCallMock.mockReset()
    runtimeEnvironmentTransportCallMock.mockImplementation(
      (args: RuntimeEnvironmentCallRequest) => {
        return (
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCallMock(args)
        )
      }
    )
    clearRuntimeCompatibilityCacheForTests()
    installHooksApiMock()
    __resetTrustPromptChainForTests()
  })

  const remoteRepoState = (overrides?: Partial<Record<keyof AppState, unknown>>) =>
    createTestState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' },
      repos: [{ id: 'repo-1', displayName: 'Repo One', executionHostId: 'runtime:owner-env' }],
      ...overrides
    })

  const mockRemoteHookResponses = (globalHookDefaults: unknown) =>
    runtimeEnvironmentCallMock.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      Promise.resolve({
        id: 'rpc',
        ok: true,
        result:
          args.method === 'repo.hooks'
            ? {
                hasHooksFile: false,
                hooks: null,
                setupRunPolicy: 'run-by-default',
                source: null,
                globalHookDefaults
              }
            : { hasHooks: false, hooks: null, mayNeedUpdate: false },
        _meta: { runtimeId: 'runtime-owner' }
      })
    )

  it('prompts with the owning host fallback when the client has none', async () => {
    const { state, pending } = remoteRepoState()
    mockRemoteHookResponses({ setup: 'host global setup', archive: '' })

    const promise = ensureHooksConfirmed(state, 'repo-1', 'setup')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data.scriptContent).toBe('host global setup')

    pending[0].resolve('run')
    await expect(promise).resolves.toBe('run')
  })

  it('hashes the owning host fallback when client and host differ', async () => {
    const { state, pending } = remoteRepoState({
      settings: {
        activeRuntimeEnvironmentId: 'focused-env',
        globalHookDefaults: { setup: 'client global setup', archive: '' }
      }
    })
    mockRemoteHookResponses({ setup: 'host global setup', archive: '' })

    const promise = ensureHooksConfirmed(state, 'repo-1', 'setup')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data.scriptContent).toBe('host global setup')
    expect(pending[0].data.contentHash).toBe(await hashOrcaHookScript('host global setup'))

    pending[0].resolve('run')
    await expect(promise).resolves.toBe('run')
  })

  it('fails closed when the owning host hook read errors', async () => {
    const { state, pending } = remoteRepoState()
    runtimeEnvironmentCallMock.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      args.method === 'repo.hooks'
        ? Promise.reject(new Error('unreachable'))
        : Promise.resolve({
            id: 'rpc',
            ok: true,
            result: { hasHooks: false, hooks: null, mayNeedUpdate: false },
            _meta: { runtimeId: 'runtime-owner' }
          })
    )

    await expect(ensureHooksConfirmed(state, 'repo-1', 'setup')).resolves.toBe('skip')
    expect(pending).toHaveLength(0)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UNRESOLVED_OWNER_HOST_ID, getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { ForgeProjectPolicyPatch } from '../../../../shared/forge-inbox-project-policy-patch'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  readProjectEventPolicy,
  retryProjectEvent,
  updateProjectEventPolicy
} from '@/runtime/project-event-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { projectEventOwnerTarget } from './project-event-owner-scope'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/workspaces/repo-1',
    displayName: 'repo-1',
    badgeColor: '#000000',
    addedAt: 1,
    ...overrides
  }
}

/** The owner id a host reports from `forgeInbox.getStatus`; opaque to routing, so only the target matters. */
function ownerHostIdFor(repo: Repo): string {
  return `owner-${getRepoExecutionHostId(repo)}`
}

function targetFor(repo: Repo): RuntimeClientTarget {
  const target = projectEventOwnerTarget(repo)
  if (target === null) {
    throw new Error(`expected a routable project event target for ${String(repo.executionHostId)}`)
  }
  return target
}

function paramsOwnerHostId(params: unknown): string | null {
  if (params === null || typeof params !== 'object' || !('ownerHostId' in params)) {
    return null
  }
  return typeof params.ownerHostId === 'string' ? params.ownerHostId : null
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(callRuntimeRpc).mockResolvedValue({})
})

describe('project event owner routing', () => {
  it('routes two rows sharing a repo id to their own host, never the other', async () => {
    const localRepo = makeRepo({ executionHostId: 'local' })
    const remoteRepo = makeRepo({ executionHostId: 'runtime:env-b' })
    const localTarget = targetFor(localRepo)
    const remoteTarget = targetFor(remoteRepo)
    expect(localTarget).toEqual({ kind: 'local' })
    expect(remoteTarget).toEqual({ kind: 'environment', environmentId: 'env-b' })

    await readProjectEventPolicy(ownerHostIdFor(localRepo), localRepo.id, localTarget)
    await readProjectEventPolicy(ownerHostIdFor(remoteRepo), remoteRepo.id, remoteTarget)

    const calls = vi.mocked(callRuntimeRpc).mock.calls
    expect(calls).toEqual([
      [
        localTarget,
        'forgeInbox.getProjectEventPolicy',
        { ownerHostId: 'owner-local', repoId: 'repo-1' }
      ],
      [
        remoteTarget,
        'forgeInbox.getProjectEventPolicy',
        { ownerHostId: 'owner-runtime:env-b', repoId: 'repo-1' }
      ]
    ])
    const remoteCalls = calls.filter(
      ([, , params]) => paramsOwnerHostId(params) === 'owner-runtime:env-b'
    )
    expect(remoteCalls).toHaveLength(1)
    expect(remoteCalls.every(([target]) => target.kind === 'environment')).toBe(true)
    const localCalls = calls.filter(([, , params]) => paramsOwnerHostId(params) === 'owner-local')
    expect(localCalls).toHaveLength(1)
    expect(localCalls.every(([target]) => target.kind === 'local')).toBe(true)
  })

  it('keeps a folder workspace on its runtime host for a compare-and-set write', async () => {
    const folder = makeRepo({ kind: 'folder', executionHostId: 'runtime:env-b' })
    const target = targetFor(folder)
    expect(target).toEqual({ kind: 'environment', environmentId: 'env-b' })
    const patch: ForgeProjectPolicyPatch = { enabled: true, agentId: 'claude', rules: '# rules' }

    await updateProjectEventPolicy(ownerHostIdFor(folder), folder.id, 7, patch, target)

    expect(vi.mocked(callRuntimeRpc).mock.calls).toEqual([
      [
        target,
        'forgeInbox.updateProjectEventPolicy',
        {
          ownerHostId: 'owner-runtime:env-b',
          repoId: 'repo-1',
          expectedGeneration: 7,
          patch
        }
      ]
    ])
  })

  it('gives direct SSH and unresolved-owner rows no target, so no RPC is issued', () => {
    const sshRow = makeRepo({ executionHostId: 'ssh:dev-box' })
    const legacySshRow = makeRepo({ connectionId: 'dev-box' })
    const unresolvedRow = makeRepo({ executionHostId: UNRESOLVED_OWNER_HOST_ID })

    expect(projectEventOwnerTarget(sshRow)).toBeNull()
    expect(projectEventOwnerTarget(legacySshRow)).toBeNull()
    expect(projectEventOwnerTarget(unresolvedRow)).toBeNull()
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('surfaces an owner mismatch on a remote retry without a retry or local fallback', async () => {
    const remoteRepo = makeRepo({ executionHostId: 'runtime:env-b' })
    const target = targetFor(remoteRepo)
    const ownerMismatch = new RuntimeRpcCallError({
      id: 'retry-1',
      ok: false,
      error: { code: 'forge_inbox_owner_mismatch', message: 'owner mismatch' },
      _meta: { runtimeId: 'env-b' }
    })
    vi.mocked(callRuntimeRpc).mockRejectedValue(ownerMismatch)

    await expect(retryProjectEvent(ownerHostIdFor(remoteRepo), remoteRepo.id, target)).rejects.toBe(
      ownerMismatch
    )
    expect(vi.mocked(callRuntimeRpc).mock.calls).toEqual([
      [
        target,
        'forgeInbox.retryProjectEvent',
        { ownerHostId: 'owner-runtime:env-b', repoId: 'repo-1' }
      ]
    ])
  })
})

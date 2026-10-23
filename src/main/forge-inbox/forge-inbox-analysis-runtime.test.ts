import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../shared/execution-host'
import { requireProtectedClaudeLaunchSources } from '../claude/claude-protected-launch-sources'
import {
  createForgeInboxRuntimeAnalysis,
  forgeAnalysisSessionHost,
  forgeAnalysisWorkspacePath
} from './forge-inbox-analysis-runtime'

const target =
  (executionHostId: ExecutionHostId, path = '/work/repo') =>
  async () => ({ worktree: { path }, executionHostId })

describe('forge inbox runtime analysis', () => {
  const getSettings = () => ({ agentDefaultEnv: {} })
  const scanRoots = async () => ['/scan/claude']
  const ensureHost = vi.fn(async () => {
    throw new Error('host_should_not_be_asked')
  })

  it('installs the protected launch sources without opening a session host', () => {
    createForgeInboxRuntimeAnalysis({
      runtime: {
        stateDirectory: '/state',
        getSettings,
        scanRoots,
        resolveWorkspacePath: async () => null,
        ensureHost
      },
      http: {
        fetch: async () => {
          throw new Error('no_request_expected')
        }
      }
    })

    // Without this the structured registry refuses every protected Claude launch.
    const sources = requireProtectedClaudeLaunchSources()
    expect(sources.getSettings).toBe(getSettings)
    expect(sources.scanRoots).toBe(scanRoots)
    expect(ensureHost).not.toHaveBeenCalled()
  })
})

describe('forge analysis workspace binding', () => {
  it('only names a directory for a workspace this host runs', async () => {
    expect(
      await forgeAnalysisWorkspacePath(
        { resolveRuntimeFileTarget: target(LOCAL_EXECUTION_HOST_ID) },
        'ws-1'
      )
    ).toBe('/work/repo')
    // The path exists on another machine; running here would analyse the wrong files.
    expect(
      await forgeAnalysisWorkspacePath(
        { resolveRuntimeFileTarget: target(toRuntimeExecutionHostId('env-1')) },
        'ws-1'
      )
    ).toBeNull()
    expect(
      await forgeAnalysisWorkspacePath(
        {
          resolveRuntimeFileTarget: async () => {
            throw new Error('worktree_execution_host_unresolved')
          }
        },
        'ws-1'
      )
    ).toBeNull()
  })

  it('propagates an unavailable session host instead of reusing one', async () => {
    await expect(
      forgeAnalysisSessionHost({
        ensureStructuredAgentSessionHost: async () => {
          throw new Error('host_unavailable')
        }
      })
    ).rejects.toThrow('host_unavailable')
  })
})

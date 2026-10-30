import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./notifications-test-harness')).createElectronModuleMock()
)

vi.mock('./notification-authorization-status', async () =>
  (await import('./notifications-test-harness')).createNotificationAuthorizationModuleMock()
)

vi.mock('./ui', async () =>
  (await import('./notifications-test-harness')).createTrustedUIRendererModuleMock()
)

vi.mock('../tray/system-tray', async () =>
  (await import('./notifications-test-harness')).createSystemTrayModuleMock()
)

import { getDefaultNotificationSettings } from '../../shared/notification-settings-defaults'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { registerNotificationHandlers } from './notifications'
import {
  createNotificationRuntimeStub,
  getDispatchHandler,
  resetNotificationDispatchMocks
} from './notifications-test-harness'

const SCOPE = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'repo-1::/work/feature',
  workspaceKind: 'git-worktree'
} as const

const DISPATCHED_SESSION = 'forge-session'

function structuredCompletion(sessionId: string): NotificationDispatchRequest {
  return {
    source: 'agent-task-complete',
    surface: 'agent-session',
    worktreeId: SCOPE.workspaceId,
    agentState: 'done',
    structuredOrigin: {
      scope: SCOPE,
      sessionId,
      cause: { kind: 'completion', requestId: `turn-${sessionId}` },
      journalCursor: { epoch: 'e', sequence: 1 }
    }
  }
}

describe('notifications:dispatch with a Forge dispatched agent', () => {
  let runtime: ReturnType<typeof createNotificationRuntimeStub>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-28T16:00:00Z'))
    resetNotificationDispatchMocks()
    runtime = createNotificationRuntimeStub([DISPATCHED_SESSION])
    registerNotificationHandlers(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration reads only getSettings from this partial store; no delivery service is faked.
      { getSettings: () => ({ notifications: getDefaultNotificationSettings() }) } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub carries exactly the runtime members this registration reads; no delivery service is faked.
      runtime as unknown as OrcaRuntimeService
    )
  })

  it('leaves a dispatched agent completion to Forge on both desktop and phone', async () => {
    const handler = getDispatchHandler()

    expect(await handler({}, structuredCompletion(DISPATCHED_SESSION))).toEqual({
      delivered: false,
      reason: 'source-disabled'
    })
    expect(runtime.dispatchMobileNotification).not.toHaveBeenCalled()
    expect(runtime.getTerminalHandleForPaneKey).not.toHaveBeenCalled()
  })

  it('delivers an unrelated agent completion to the desktop and the phone', async () => {
    const handler = getDispatchHandler()

    expect(await handler({}, structuredCompletion('someone-elses-session'))).toEqual({
      delivered: true
    })
    expect(runtime.dispatchMobileNotification).toHaveBeenCalledTimes(1)
    expect(runtime.dispatchMobileNotification.mock.calls[0]?.[0]).toMatchObject({
      source: 'agent-task-complete',
      worktreeId: SCOPE.workspaceId,
      agentState: 'done'
    })
  })
})

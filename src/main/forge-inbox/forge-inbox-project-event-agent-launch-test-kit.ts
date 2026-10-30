import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { TuiAgent } from '../../shared/tui-agent'
import type {
  ProjectEventAgentLaunchPorts,
  ProjectEventAgentLaunchRuntime,
  ProjectEventStructuredSessionCreate
} from './forge-inbox-project-event-agent-launch'

export const REPO_ID = 'repo-1'
export const REPO_PATH = '/work/repo'
export const WORKSPACE_ID = `repo-1::${REPO_PATH}`
export const MODEL = 'claude-sonnet-5-5'
export const PROMPT = 'Run the project event.\n'

export type Probe = {
  resolved: string[]
  created: Parameters<ProjectEventStructuredSessionCreate>[0][]
  delivered: Parameters<ProjectEventAgentLaunchPorts['deliverStructuredPrompt']>[0][]
  terminal: { selector: string; agent: TuiAgent; prompt: string; title?: string }[]
  watched: { sessionId: string; runId: number }[]
  order: string[]
}

export function only<T>(items: readonly T[]): T {
  const [first, ...rest] = items
  if (first === undefined || rest.length > 0) {
    throw new Error(`expected exactly one entry, got ${items.length}`)
  }
  return first
}

export function launchPorts(
  probe: Probe,
  options: {
    runtime?: Partial<ProjectEventAgentLaunchRuntime>
    refusal?: { code: string; message: string }
    messageId?: string | null
    deliverError?: Error
  } = {}
): ProjectEventAgentLaunchPorts {
  return {
    runtime: {
      requireStore: () => ({
        getSettings: () => ({ experimentalNativeChat: true }),
        getRepo: () => ({ path: REPO_PATH, connectionId: null })
      }),
      getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
      ensureStructuredAgentSessionHost: async () => {},
      launchAgentTerminal: async (selector, launch) => {
        probe.terminal.push({ selector, ...launch })
        return {
          handle: 'terminal-1',
          ptyId: 'pty-a',
          incarnationId: 'incarnation-a',
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          worktreeId: WORKSPACE_ID
        }
      },
      resolveRuntimeFileTarget: async (selector) => {
        probe.resolved.push(selector)
        return {
          worktree: { path: REPO_PATH, id: WORKSPACE_ID, repoId: REPO_ID },
          executionHostId: LOCAL_EXECUTION_HOST_ID
        }
      },
      ...options.runtime
    },
    createStructuredSession: async (args) => {
      probe.created.push(args)
      return options.refusal
        ? { ok: false, refusal: options.refusal }
        : { ok: true, value: { sessionId: args.envelope.sessionId, fence: 4, tabId: 'tab-1' } }
    },
    deliverStructuredPrompt: async (args) => {
      probe.order.push('deliver')
      probe.delivered.push(args)
      if (options.deliverError) {
        throw options.deliverError
      }
      return options.messageId === undefined ? args.clientMessageId : options.messageId
    },
    runWatch: {
      watch: (sessionId, runId) => {
        probe.order.push('watch')
        probe.watched.push({ sessionId, runId })
      },
      dispose: () => {},
      isDisposed: () => false
    }
  }
}

export function emptyProbe(): Probe {
  return { resolved: [], created: [], delivered: [], terminal: [], watched: [], order: [] }
}

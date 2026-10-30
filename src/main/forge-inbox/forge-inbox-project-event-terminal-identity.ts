import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import { boundedCall } from './forge-inbox-bounded-call'
import type { ProjectEventTerminalRuntime } from './forge-inbox-project-event-terminal-observer'
import type {
  RunTerminalExit,
  RunTerminalIdentity
} from './forge-inbox-project-event-run-terminal-state'
import { resolveUnreportedExitCause } from '../../shared/terminal-exit-cause'
import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'

const TERMINAL_LIST_LIMIT = 500

/**
 * The runtime names a listed terminal's host only when it can. A PTY id that embeds no remote owner
 * belongs to this machine, so an unnamed host proves the recorded one only when that was local.
 */
function sameExecutionHost(
  terminal: { executionHostId?: string | undefined },
  ptyId: string,
  recorded: string
): boolean {
  if (terminal.executionHostId !== undefined) {
    return terminal.executionHostId === recorded
  }
  return recorded === LOCAL_EXECUTION_HOST_ID && getPtyExecutionHost(ptyId) === null
}

export type ResolvedTerminal =
  | { kind: 'found'; handle: string }
  | { kind: 'absent' }
  | { kind: 'failed' }
  /** The launch never reported the whole identity, so no terminal could ever be proven to be this one. */
  | { kind: 'unprovable' }

/**
 * Finds the terminal that still has this exact PTY, incarnation and host, under whatever handle the
 * runtime now gives it. It only lists: a handle that merely resolves is never taken for the terminal.
 */
export async function resolveRunTerminal(
  runtime: ProjectEventTerminalRuntime,
  identity: RunTerminalIdentity,
  signal: AbortSignal,
  timeoutMs: number
): Promise<ResolvedTerminal> {
  const { ptyId, incarnationId, executionHostId } = identity
  if (ptyId === null || incarnationId === null || executionHostId === null) {
    return { kind: 'unprovable' }
  }
  const listed = await boundedCall(
    signal,
    runtime.listTerminals(`id:${identity.worktreeId}`, TERMINAL_LIST_LIMIT, {
      requireFreshPtyLiveness: true
    }),
    timeoutMs
  )
  if (!listed.ok) {
    return { kind: 'failed' }
  }
  const match = listed.value.terminals.find(
    (terminal) =>
      terminal.orphaned !== true &&
      terminal.ptyId === ptyId &&
      terminal.incarnationId === incarnationId &&
      sameExecutionHost(terminal, ptyId, executionHostId)
  )
  return match ? { kind: 'found', handle: match.handle } : { kind: 'absent' }
}

/** Only an exited status is an exit; a code with no host-vouched cause is never read as a clean finish. */
export function terminalExitFact(
  result: Pick<RuntimeTerminalWait, 'status' | 'exitCode' | 'exitCause'>
): RunTerminalExit | null {
  if (result.status !== 'exited' || result.exitCode === null) {
    return null
  }
  const cause = result.exitCause ?? resolveUnreportedExitCause(result.exitCode)
  switch (cause.kind) {
    case 'exited':
      return { kind: 'exited', value: cause.exitCode }
    case 'signaled':
      return { kind: 'signaled', value: cause.signal }
    case 'operator_close':
      return { kind: 'operator_close', value: null }
    case 'unknown':
      return { kind: 'unknown', value: result.exitCode >= 0 ? result.exitCode : null }
  }
}

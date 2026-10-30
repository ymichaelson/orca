import type { ExecutionHostId } from '../../shared/execution-host'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { SecretStore } from '../../shared/secret-store'
import { ForgeInboxLedger as Ledger } from './forge-inbox-ledger'
import { createDispatchConfirmation } from './forge-inbox-dispatch-confirmation'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ProjectEventTerminalRuntime } from './forge-inbox-project-event-terminal-observer'
import { seedRun, updatePolicy } from './forge-inbox-project-event-run-cancel-test-kit'
import { bindRunTerminal } from './forge-inbox-project-event-run-terminal-state'
import { transitionForgeRun } from './forge-inbox-runs'

export const TERMINAL_WORKTREE = 'repo-1::/work/repo'

export type FakeTerminalIdentity = {
  ptyId: string
  incarnationId: string
  executionHostId: ExecutionHostId
}

export const PTY_A: FakeTerminalIdentity = {
  ptyId: 'pty-a',
  incarnationId: 'incarnation-a',
  executionHostId: 'local'
}

type Waiter = {
  handle: string
  resolve: (result: Awaited<ReturnType<ProjectEventTerminalRuntime['waitForTerminal']>>) => void
  reject: (error: Error) => void
}

/** A terminal runtime double with the real wait contract: a signalled waiter is released on abort. */
export function createFakeTerminalRuntime() {
  const terminals = new Map<
    string,
    FakeTerminalIdentity & { orphaned?: boolean; hostless?: boolean }
  >()
  const waiters = new Set<Waiter>()
  const order: string[] = []
  const closes: string[] = []
  const waits: string[] = []
  let listGate: Promise<void> | null = null
  let nextListGate: Promise<void> | null = null
  const control: { listError: Error | null; closeError: Error | null; ignoreAbort: boolean } = {
    listError: null,
    closeError: null,
    ignoreAbort: false
  }
  const runtime: ProjectEventTerminalRuntime = {
    waitForTerminal: (handle, { signal }) =>
      new Promise((resolve, reject) => {
        order.push('wait')
        waits.push(handle)
        const waiter: Waiter = { handle, resolve, reject }
        waiters.add(waiter)
        if (!control.ignoreAbort) {
          signal.addEventListener(
            'abort',
            () => {
              waiters.delete(waiter)
              reject(new Error('request_aborted'))
            },
            { once: true }
          )
        }
      }),
    closeTerminal: async (handle) => {
      order.push('close')
      closes.push(handle)
      if (control.closeError) {
        throw control.closeError
      }
      return { handle, tabId: 'tab-1', ptyKilled: true }
    },
    listTerminals: async () => {
      order.push('list')
      const first = nextListGate
      nextListGate = null
      await first
      await listGate
      if (control.listError) {
        throw control.listError
      }
      return {
        terminals: [...terminals].map(([handle, identity]) => ({
          handle,
          ptyId: identity.ptyId,
          incarnationId: identity.incarnationId,
          ...(identity.hostless ? {} : { executionHostId: identity.executionHostId }),
          ...(identity.orphaned ? { orphaned: true as const } : {})
        }))
      }
    }
  }
  const settle = (
    handle: string,
    result: Awaited<ReturnType<ProjectEventTerminalRuntime['waitForTerminal']>>
  ): void => {
    for (const waiter of waiters) {
      if (waiter.handle === handle) {
        waiters.delete(waiter)
        waiter.resolve(result)
      }
    }
  }
  return {
    runtime,
    terminals,
    order,
    closes,
    waits,
    control,
    waiterCount: () => waiters.size,
    /** The process ends and the host reports it, as `waitForTerminal` does for an exit. */
    exit(handle: string, exitCode: number, exitCause?: TerminalExitCause): void {
      settle(handle, {
        status: 'exited',
        satisfied: true,
        exitCode,
        ...(exitCause ? { exitCause } : {})
      })
    },
    /** The runtime stops honoring the handle: its waiters are rejected, not resolved. */
    invalidate(handle: string): void {
      for (const waiter of waiters) {
        if (waiter.handle === handle) {
          waiters.delete(waiter)
          waiter.reject(new Error('terminal_handle_stale'))
        }
      }
    },
    /** Contact lost: the wait answers, but it is not an exit, even when it carries a code. */
    disconnect(
      handle: string,
      exitCode: number | null = null,
      status: 'unknown' | 'running' = 'unknown'
    ): void {
      settle(handle, { status, satisfied: true, exitCode })
    },
    /** Holds only the next listing; later ones answer at once. */
    holdNextList(): () => void {
      let release: () => void = () => undefined
      nextListGate = new Promise<void>((resolve) => {
        release = resolve
      })
      return release
    },
    holdList(): () => void {
      let release: () => void = () => undefined
      listGate = new Promise<void>((resolve) => {
        release = () => {
          listGate = null
          resolve()
        }
      })
      return release
    }
  }
}

/** A dispatch whose agent runs in a terminal: unverifiable at handoff, with its effect row unconfirmed. */
export function seedTerminalRun(
  ledger: ForgeInboxLedger,
  options: {
    iid?: number
    instanceId?: string
    worktreeId?: string
    handle?: string
    identity?: Partial<Record<keyof FakeTerminalIdentity, string | null>>
  } = {}
): number {
  const ctx = ledger.ledgerContext()
  const runId = seedRun(ledger, {
    iid: options.iid ?? 7,
    ...(options.instanceId === undefined ? {} : { instanceId: options.instanceId }),
    sessionId: null,
    messageId: null
  })
  const link = ledger.getProjectEventRepoLink('repo-1')
  if (!link) {
    throw new Error('fixture repo is not linked')
  }
  createDispatchConfirmation(ctx, {
    runId,
    bindingId: link.bindingId,
    gitlabHost: 'gitlab.test',
    gitlabProjectId: 3,
    itemKind: 'merge_request',
    itemIid: options.iid ?? 7,
    expectedSha: null
  })
  const identity = { ...PTY_A, ...options.identity }
  bindRunTerminal(ctx, runId, {
    handle: options.handle ?? 'handle-1',
    ptyId: identity.ptyId,
    incarnationId: identity.incarnationId,
    executionHostId: identity.executionHostId,
    worktreeId: options.worktreeId ?? TERMINAL_WORKTREE
  })
  transitionForgeRun(ctx, runId, { to: 'unverifiable', error: 'terminal-handoff' })
  return runId
}

export function terminalRow(ledger: ForgeInboxLedger, runId: number) {
  const row = ledger
    .ledgerContext()
    .db.prepare(
      `SELECT r.state, r.error, r.terminal_handle, r.terminal_exit_kind, r.terminal_exit_value,
         r.cancel_requested_at, r.cancel_delivery, r.dispatch_agent_id, r.dispatch_requested_model,
         r.dispatch_actual_model, c.state AS confirmation, c.evidence_json
       FROM runs r LEFT JOIN run_dispatch_confirmations c ON c.run_id = r.id WHERE r.id = ?`
    )
    .get(runId)
  if (!row) {
    throw new Error(`run ${runId} is missing`)
  }
  return row
}

/** What a crash leaves behind: a dispatched terminal whose stop was committed with a policy change. */
export function seedCommittedTerminalStop(dbPath: string, secretStore: SecretStore): number {
  const ledger = Ledger.open(dbPath, { secretStore })
  try {
    updatePolicy(ledger, 'repo-1', { agentId: 'claude', model: 'claude-sonnet-5-5' })
    const runId = seedTerminalRun(ledger, { instanceId: 'gitlab:gitlab.example.com' })
    updatePolicy(ledger, 'repo-1', { rules: 'New rules.' })
    return runId
  } finally {
    ledger.close()
  }
}

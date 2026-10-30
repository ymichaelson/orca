import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  withObservedExitRuntime,
  type ObservedExitScope
} from '../runtime/terminal-close-observed-exit-test-fixture'
import { createForgeProjectEventTerminalObserver } from './forge-inbox-project-event-terminal-observer'
import { projectEventTerminalRuntimeFor } from './forge-inbox-project-event-run-cancel-runtime'
import {
  CANCEL_REPO_ID,
  openDispatchLedger,
  updatePolicy,
  type DispatchLedgerFixture
} from './forge-inbox-project-event-run-cancel-test-kit'
import { seedTerminalRun, terminalRow } from './forge-inbox-project-event-terminal-test-kit'

describe('the terminal observer against the real runtime', () => {
  let fx: DispatchLedgerFixture
  beforeEach(() => {
    fx = openDispatchLedger()
  })
  afterEach(() => fx.dispose())

  function dispatchedTerminal(scope: ObservedExitScope): number {
    const { terminal, worktreeId } = scope
    return seedTerminalRun(fx.ledger, {
      handle: terminal.handle,
      worktreeId,
      identity: {
        ptyId: terminal.ptyId,
        incarnationId: terminal.incarnationId ?? null,
        executionHostId: 'local'
      }
    })
  }

  /** The real wait, close and listing, with only the order of their use recorded. */
  function observe(scope: ObservedExitScope, maxAttempts = 10) {
    const real = projectEventTerminalRuntimeFor(scope.runtime)
    const calls: string[] = []
    const observer = createForgeProjectEventTerminalObserver({
      ledger: fx.ledger,
      runtime: {
        waitForTerminal: (handle, options) => {
          calls.push('wait')
          return real.waitForTerminal(handle, options)
        },
        closeTerminal: (handle) => {
          calls.push('close')
          return real.closeTerminal(handle)
        },
        listTerminals: (...args) => real.listTerminals(...args)
      },
      retryDelayMs: 5,
      maxAttempts
    })
    return { observer, calls }
  }

  it('closes through the real runtime and records the exit it causes as a process fact', async () => {
    await withObservedExitRuntime(
      'healthy',
      async (scope) => {
        const runId = dispatchedTerminal(scope)
        const { observer, calls } = observe(scope)
        await vi.waitFor(() => expect(calls).toEqual(['wait']))

        updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

        await vi.waitFor(
          () => expect(terminalRow(fx.ledger, runId).terminal_exit_kind).toBe('operator_close'),
          { timeout: 8_000 }
        )
        await vi.waitFor(() =>
          expect(terminalRow(fx.ledger, runId).cancel_delivery).toBe('accepted')
        )
        expect(calls).toEqual(['wait', 'close'])
        expect(terminalRow(fx.ledger, runId)).toMatchObject({
          state: 'unverifiable',
          error: 'terminal-handoff',
          terminal_exit_value: null,
          confirmation: 'unconfirmable'
        })
        await observer.stop()
      },
      { inventory: true }
    )
  })

  it('closes nothing, and says so, when the runtime cannot freshly prove the terminal is live', async () => {
    await withObservedExitRuntime('healthy', async (scope) => {
      const runId = dispatchedTerminal(scope)
      const { observer, calls } = observe(scope, 2)

      updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

      await vi.waitFor(
        () => expect(terminalRow(fx.ledger, runId).cancel_delivery).toBe('unreachable'),
        { timeout: 8_000 }
      )
      expect(calls).toEqual([])
      expect(terminalRow(fx.ledger, runId).terminal_exit_kind).toBeNull()
      expect((await scope.harness.capture()).providerHasPty).toBe(true)
      await observer.stop()
    })
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listDueDispatchConfirmations } from './forge-inbox-dispatch-confirmation'
import {
  CANCEL_REPO_ID,
  createFakeCancelHost,
  createFakeCancelRuntime,
  openDispatchLedger,
  runRow,
  updatePolicy,
  type DispatchLedgerFixture
} from './forge-inbox-project-event-run-cancel-test-kit'
import { createForgeProjectEventRunCancel } from './forge-inbox-project-event-run-cancel'
import {
  createForgeProjectEventTerminalObserver,
  type ProjectEventTerminalObserver
} from './forge-inbox-project-event-terminal-observer'
import {
  createFakeTerminalRuntime,
  PTY_A,
  seedTerminalRun,
  terminalRow
} from './forge-inbox-project-event-terminal-test-kit'
import type { ForgeInboxLedger } from './forge-inbox-ledger'

describe('observing and stopping a dispatched terminal', () => {
  let fx: DispatchLedgerFixture
  let fake: ReturnType<typeof createFakeTerminalRuntime>
  let observers: ProjectEventTerminalObserver[]
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fx = openDispatchLedger()
    fake = createFakeTerminalRuntime()
    fake.terminals.set('handle-1', PTY_A)
    observers = []
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(async () => {
    await Promise.all(observers.map((observer) => observer.stop()))
    fx.dispose()
    vi.useRealTimers()
    warn.mockRestore()
  })

  function observe(
    options: { ledger?: ForgeInboxLedger; maxAttempts?: number; giveUpCooldownMs?: number } = {}
  ) {
    const observer = createForgeProjectEventTerminalObserver({
      ledger: options.ledger ?? fx.ledger,
      runtime: fake.runtime,
      retryDelayMs: 1,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options.giveUpCooldownMs === undefined
        ? {}
        : { giveUpCooldownMs: options.giveUpCooldownMs })
    })
    observers.push(observer)
    return observer
  }

  it('waits on the terminal that exactly matches the recorded PTY identity', async () => {
    const runId = seedTerminalRun(fx.ledger)

    observe()

    await vi.waitFor(() => expect(fake.waiterCount()).toBe(1))
    expect(fake.waits).toEqual(['handle-1'])
    expect(fake.closes).toEqual([])
    expect(terminalRow(fx.ledger, runId)).toMatchObject({
      state: 'unverifiable',
      error: 'terminal-handoff',
      terminal_exit_kind: null
    })
  })

  it.each([
    ['a clean exit code', 0, { kind: 'exited' as const, exitCode: 0 }, 'exited', 0],
    ['a failing exit code', 3, { kind: 'exited' as const, exitCode: 3 }, 'exited', 3],
    ['a signal', 0, { kind: 'signaled' as const, signal: 9 }, 'signaled', 9],
    ['an operator close', 0, { kind: 'operator_close' as const }, 'operator_close', null],
    ['an exit whose cause the host never reported', 0, undefined, 'unknown', 0]
  ])(
    'records %s as a process fact and never as the task result',
    async (_name, exitCode, cause, kind, value) => {
      const runId = seedTerminalRun(fx.ledger)
      observe()
      await vi.waitFor(() => expect(fake.waiterCount()).toBe(1))

      fake.exit('handle-1', exitCode, cause)

      await vi.waitFor(() => expect(terminalRow(fx.ledger, runId).terminal_exit_kind).toBe(kind))
      const row = terminalRow(fx.ledger, runId)
      expect(row).toMatchObject({
        terminal_exit_value: value,
        // The process ending says nothing about what the agent did on GitLab.
        state: 'unverifiable',
        error: 'terminal-handoff',
        confirmation: 'unconfirmable'
      })
      expect(JSON.parse(String(row.evidence_json))).toMatchObject({ code: 'report-missing' })
      expect(listDueDispatchConfirmations(fx.ledger.ledgerContext(), 10)).toEqual([])
    }
  )

  it('treats a disconnected wait as unconfirmed, not as an exit', async () => {
    const runId = seedTerminalRun(fx.ledger)
    observe()
    await vi.waitFor(() => expect(fake.waiterCount()).toBe(1))

    fake.disconnect('handle-1')
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(terminalRow(fx.ledger, runId)).toMatchObject({
      terminal_exit_kind: null,
      confirmation: 'unconfirmed'
    })
  })

  it.each([
    ['an unknown status carrying the unverified sentinel code', -1, 'unknown' as const],
    ['a status that is not an exit even with a zero code', 0, 'running' as const]
  ])('does not read %s as an exit', async (_name, exitCode, status) => {
    const runId = seedTerminalRun(fx.ledger)
    observe()
    await vi.waitFor(() => expect(fake.waiterCount()).toBe(1))

    fake.disconnect('handle-1', exitCode, status)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(terminalRow(fx.ledger, runId)).toMatchObject({
      terminal_exit_kind: null,
      confirmation: 'unconfirmed'
    })
  })

  it('recognizes a local PTY the runtime lists without naming its host', async () => {
    seedTerminalRun(fx.ledger)
    fake.terminals.set('handle-1', { ...PTY_A, hostless: true })

    observe()

    await vi.waitFor(() => expect(fake.waits).toEqual(['handle-1']))
  })

  it('does not take an unnamed host for a recorded remote one, or for a remote-looking PTY id', async () => {
    seedTerminalRun(fx.ledger, { identity: { executionHostId: 'ssh:builder' } })
    fake.terminals.set('handle-1', { ...PTY_A, executionHostId: 'ssh:builder', hostless: true })

    observe({ maxAttempts: 2 })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(fake.waits).toEqual([])
  })

  it('does not take an unnamed host for local when the PTY id embeds a remote owner', async () => {
    const remotePty = 'ssh:builder@@pty-1'
    seedTerminalRun(fx.ledger, { identity: { ptyId: remotePty } })
    fake.terminals.clear()
    fake.terminals.set('handle-1', { ...PTY_A, ptyId: remotePty, hostless: true })

    observe({ maxAttempts: 2 })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(fake.waits).toEqual([])
    expect(fake.closes).toEqual([])
  })

  it('settles a run whose recorded PTY was replaced under the same handle', async () => {
    const runId = seedTerminalRun(fx.ledger)
    fake.terminals.set('handle-1', { ...PTY_A, incarnationId: 'incarnation-b' })

    observe({ maxAttempts: 2 })
    await vi.waitFor(() =>
      expect(terminalRow(fx.ledger, runId).terminal_exit_kind).toBe('operator_close')
    )

    expect(fake.waits).toEqual([])
    expect(fake.closes).toEqual([])
  })

  it('settles a run whose terminal is gone, without launching or closing one', async () => {
    const runId = seedTerminalRun(fx.ledger)
    fake.terminals.clear()

    observe({ maxAttempts: 2 })
    await vi.waitFor(() =>
      expect(terminalRow(fx.ledger, runId)).toMatchObject({
        terminal_exit_kind: 'operator_close',
        state: 'unverifiable',
        confirmation: 'unconfirmable'
      })
    )

    expect(fake.waits).toEqual([])
    expect(fake.order.filter((step) => step !== 'list')).toEqual([])
  })

  it('follows the same PTY to the handle the runtime now gives it', async () => {
    const runId = seedTerminalRun(fx.ledger)
    fake.terminals.clear()
    fake.terminals.set('handle-9', PTY_A)

    observe()

    await vi.waitFor(() => expect(fake.waits).toEqual(['handle-9']))
    expect(terminalRow(fx.ledger, runId).terminal_handle).toBe('handle-9')
  })

  it('never acts on a terminal whose identity was not fully recorded', async () => {
    seedTerminalRun(fx.ledger, { identity: { incarnationId: null } })

    observe({ maxAttempts: 2 })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(fake.waits).toEqual([])
    expect(fake.closes).toEqual([])
  })

  describe('a policy change that revokes the dispatch', () => {
    it('closes the exact terminal after its waiter exists, and stays stopping until the process ends', async () => {
      const runId = seedTerminalRun(fx.ledger)
      observe()
      await vi.waitFor(() => expect(fake.waiterCount()).toBe(1))

      updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

      await vi.waitFor(() => expect(terminalRow(fx.ledger, runId).cancel_delivery).toBe('accepted'))
      expect(fake.closes).toEqual(['handle-1'])
      expect(fake.order.indexOf('wait')).toBeLessThan(fake.order.indexOf('close'))
      // A close receipt is not an exit.
      expect(terminalRow(fx.ledger, runId)).toMatchObject({
        terminal_exit_kind: null,
        state: 'unverifiable',
        confirmation: 'unconfirmed'
      })

      fake.exit('handle-1', 0, { kind: 'operator_close' })

      await vi.waitFor(() =>
        expect(terminalRow(fx.ledger, runId).terminal_exit_kind).toBe('operator_close')
      )
    })

    it('still registers its waiter before it closes when the stop was committed before it started', async () => {
      const runId = seedTerminalRun(fx.ledger)
      updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

      observe()

      await vi.waitFor(() => expect(terminalRow(fx.ledger, runId).cancel_delivery).toBe('accepted'))
      expect(fake.order.indexOf('wait')).toBeGreaterThan(-1)
      expect(fake.order.indexOf('wait')).toBeLessThan(fake.order.indexOf('close'))
      expect(fake.closes).toEqual(['handle-1'])
    })

    it('never closes before its waiter exists, even when a stop arrives while it is still looking the terminal up', async () => {
      const runId = seedTerminalRun(fx.ledger)
      const release = fake.holdNextList()
      observe()
      await vi.waitFor(() => expect(fake.order).toContain('list'))

      updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(fake.closes).toEqual([])
      release()

      await vi.waitFor(() => expect(terminalRow(fx.ledger, runId).cancel_delivery).toBe('accepted'))
      expect(fake.order.indexOf('wait')).toBeLessThan(fake.order.indexOf('close'))
    })

    it('records a refused close and does not close again', async () => {
      fake.control.closeError = new Error('terminal_handle_stale')
      const runId = seedTerminalRun(fx.ledger)
      observe()
      await vi.waitFor(() => expect(fake.waiterCount()).toBe(1))

      updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

      await vi.waitFor(() => expect(terminalRow(fx.ledger, runId).cancel_delivery).toBe('refused'))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(fake.closes).toHaveLength(1)
      expect(terminalRow(fx.ledger, runId).terminal_exit_kind).toBeNull()
    })

    it('never closes a terminal it cannot prove is the one it started', async () => {
      const runId = seedTerminalRun(fx.ledger)
      observe()
      await vi.waitFor(() => expect(fake.waiterCount()).toBe(1))
      fake.terminals.set('handle-1', { ...PTY_A, ptyId: 'pty-other' })

      updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

      await vi.waitFor(() =>
        expect(terminalRow(fx.ledger, runId).cancel_delivery).toBe('unreachable')
      )
      expect(fake.closes).toEqual([])
    })

    it('does not close a terminal that replaced the original while the lookup was in flight', async () => {
      const runId = seedTerminalRun(fx.ledger)
      observe()
      await vi.waitFor(() => expect(fake.waiterCount()).toBe(1))
      const release = fake.holdList()

      updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
      await vi.waitFor(() =>
        expect(fake.order.filter((step) => step === 'list').length).toBeGreaterThan(1)
      )
      fake.terminals.set('handle-1', { ...PTY_A, incarnationId: 'incarnation-b' })
      release()

      await vi.waitFor(() =>
        expect(terminalRow(fx.ledger, runId).cancel_delivery).toBe('unreachable')
      )
      expect(fake.closes).toEqual([])
    })

    it('is not stopped by the structured worker', async () => {
      const runId = seedTerminalRun(fx.ledger)
      const journal = createFakeCancelHost()
      const worker = createForgeProjectEventRunCancel({
        ledger: fx.ledger,
        runtime: createFakeCancelRuntime(journal.host).runtime,
        retryDelayMs: 1
      })

      updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
      await new Promise((resolve) => setTimeout(resolve, 20))
      await worker.stop()

      expect(runRow(fx.ledger, runId).cancel_requested_at).toEqual(expect.any(Number))
      expect(journal.calls).toEqual([])
      expect(journal.historyReads()).toBe(0)
    })
  })

  it('reattaches after a restart to the same PTY without launching or closing anything', async () => {
    const runId = seedTerminalRun(fx.ledger)
    const first = observe()
    await vi.waitFor(() => expect(fake.waiterCount()).toBe(1))
    await first.stop()
    fake.terminals.clear()
    fake.terminals.set('handle-restarted', PTY_A)
    const reopened = fx.reopen()

    observe({ ledger: reopened })

    await vi.waitFor(() => expect(fake.waits).toEqual(['handle-1', 'handle-restarted']))
    expect(fake.closes).toEqual([])
    expect(terminalRow(reopened, runId)).toMatchObject({
      state: 'unverifiable',
      terminal_handle: 'handle-restarted'
    })
  })

  describe('an observer that can no longer act on a stop that was asked for', () => {
    it.each([
      [
        'the terminal is gone',
        (): void => {
          fake.terminals.clear()
        },
        undefined,
        'operator_close'
      ],
      [
        'only a replacement PTY remains',
        (): void => {
          fake.terminals.set('handle-1', { ...PTY_A, incarnationId: 'incarnation-b' })
        },
        undefined,
        'operator_close'
      ],
      [
        'the listing keeps failing',
        (): void => {
          fake.control.listError = new Error('terminal_liveness_unavailable')
        },
        undefined,
        null
      ],
      [
        'the identity was never fully recorded',
        (): void => undefined,
        { incarnationId: null },
        null
      ]
    ])('says the stop is not confirmed when %s', async (_name, arrange, identity, exitKind) => {
      const runId = seedTerminalRun(fx.ledger, identity ? { identity } : {})
      arrange()
      updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

      observe({ maxAttempts: 2 })

      await vi.waitFor(() =>
        expect(terminalRow(fx.ledger, runId).cancel_delivery).toBe('unreachable')
      )
      expect(fake.closes).toEqual([])
      expect(fake.waits).toEqual([])
      expect(terminalRow(fx.ledger, runId).terminal_exit_kind).toBe(exitKind)
    })

    it('settles the run instead of waiting for a stop after its wait goes stale', async () => {
      const runId = seedTerminalRun(fx.ledger)
      observe({ maxAttempts: 3 })
      await vi.waitFor(() => expect(fake.waiterCount()).toBe(1))
      fake.terminals.clear()
      fake.invalidate('handle-1')

      await vi.waitFor(() =>
        expect(terminalRow(fx.ledger, runId).terminal_exit_kind).toBe('operator_close')
      )

      updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(fake.closes).toEqual([])
      expect(terminalRow(fx.ledger, runId).cancel_delivery).toBeNull()
    })

    it('says so when the wait ends without an exit before the stop could be sent', async () => {
      const runId = seedTerminalRun(fx.ledger)
      observe()
      await vi.waitFor(() => expect(fake.waiterCount()).toBe(1))
      fake.control.listError = new Error('terminal_liveness_unavailable')

      fake.disconnect('handle-1')
      updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

      await vi.waitFor(() =>
        expect(terminalRow(fx.ledger, runId).cancel_delivery).toBe('unreachable')
      )
      expect(fake.closes).toEqual([])
    })

    it('observes a PTY that a later listing returns instead of settling it as gone', async () => {
      const runId = seedTerminalRun(fx.ledger)
      fake.terminals.clear()
      const release = fake.holdNextList()
      observe({ maxAttempts: 3 })
      await vi.waitFor(() => expect(fake.order).toContain('list'))

      fake.terminals.set('handle-1', PTY_A)
      release()

      await vi.waitFor(() => expect(fake.waiterCount()).toBe(1))
      expect(terminalRow(fx.ledger, runId).terminal_exit_kind).toBeNull()

      fake.exit('handle-1', 0, { kind: 'operator_close' })
      await vi.waitFor(() =>
        expect(terminalRow(fx.ledger, runId).terminal_exit_kind).toBe('operator_close')
      )
    })
  })

  describe('shutting down', () => {
    it('releases its waiters and ignores an exit that arrives afterwards', async () => {
      const runId = seedTerminalRun(fx.ledger)
      const observer = observe()
      await vi.waitFor(() => expect(fake.waiterCount()).toBe(1))

      await observer.stop()
      fake.exit('handle-1', 0)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(fake.waiterCount()).toBe(0)
      expect(terminalRow(fx.ledger, runId).terminal_exit_kind).toBeNull()
      expect(warn).not.toHaveBeenCalled()
    })

    it('writes nothing once the ledger closes behind a stopped observer, and can be stopped twice', async () => {
      const runId = seedTerminalRun(fx.ledger)
      const release = fake.holdList()
      const observer = observe()
      await vi.waitFor(() => expect(fake.order).toContain('list'))

      await observer.stop()
      const reopened = fx.reopen()
      release()
      await new Promise((resolve) => setTimeout(resolve, 10))
      await observer.stop()

      expect(fake.waits).toEqual([])
      expect(terminalRow(reopened, runId).terminal_exit_kind).toBeNull()
      expect(warn).not.toHaveBeenCalled()
    })

    it('still finishes when the runtime ignores the abort, and writes nothing for a late exit', async () => {
      fake.control.ignoreAbort = true
      const runId = seedTerminalRun(fx.ledger)
      const observer = observe()
      await vi.waitFor(() => expect(fake.waiterCount()).toBe(1))

      const outcome = await Promise.race([
        observer.stop().then(() => 'stopped' as const),
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 500))
      ])
      const reopened = fx.reopen()
      fake.exit('handle-1', 0, { kind: 'operator_close' })
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(outcome).toBe('stopped')
      expect(terminalRow(reopened, runId).terminal_exit_kind).toBeNull()
      expect(warn).not.toHaveBeenCalled()
    })

    it('leaves no timer behind', async () => {
      vi.useFakeTimers()
      seedTerminalRun(fx.ledger)
      fake.terminals.clear()
      const observer = createForgeProjectEventTerminalObserver({
        ledger: fx.ledger,
        runtime: fake.runtime,
        retryDelayMs: 60_000
      })
      await vi.advanceTimersByTimeAsync(10)
      expect(vi.getTimerCount()).toBeGreaterThan(0)

      await observer.stop()

      expect(vi.getTimerCount()).toBe(0)
    })
  })
})

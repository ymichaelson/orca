import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '@orca/process-host'
import { buildClaudeChildProcessEnv } from './claude-child-process-environment'
import { withoutInheritedClaudeConfigDir } from './claude-config-dir-pin'
import {
  ClaudeControlRequestError,
  createClaudeControlSurface,
  type ClaudeControlSurface
} from './claude-agent-sdk-control-requests'
import { createClaudeChildTreeReaper, proveClaudeChildExit } from './claude-agent-sdk-exit-proof'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'
import {
  claudeSdkUserMessage,
  claudeUnwrittenUserMessageError,
  createClaudeUserMessageQueue
} from './claude-agent-sdk-user-message-queue'
import {
  protectedClaudeProcessEnvironment,
  protectedClaudeSealForLaunch
} from './claude-protected-process-seal'
import {
  createProtectedClaudeTransportGate,
  denyProtectedClaudeTool
} from './claude-protected-transport-gate'
import type {
  ClaudeChildExitVerdict,
  ClaudeStreamJsonConnectionHandlers,
  ClaudeStreamJsonLaunch
} from './claude-stream-json-connection-types'

export type {
  ClaudeChildExitVerdict,
  ClaudeStreamJsonConnectionHandlers,
  ClaudeStreamJsonLaunch
} from './claude-stream-json-connection-types'
import { claudeStreamJsonExitError, type ClaudeExitStatus } from './claude-stream-json-exit-error'
import { withMissingProviderExecutable } from '../provider-process/provider-executable-missing'

export { ClaudeControlRequestError }

/** How long a proven close waits for messages already written before the exit; whatever still
 *  holds the output open past it is no reason to keep the close unresolved. */
export const CLAUDE_READER_DRAIN_AFTER_EXIT_MS = 2_000

/**
 * The SDK is loaded at the structured-Claude boundary rather than by this module's
 * import. The ordinary runtime's class graph statically reaches this file, and the
 * SDK sets `process.env.NoDefaultCurrentDirectoryInExePath` at import time — a
 * Windows executable-search change that a user who never leaves the terminal/TUI
 * path never opted into, and a missing SDK would fail runtime startup. Memoized,
 * so a session pays the import once per process rather than once per connection.
 */

let claudeAgentSdk: Promise<typeof ClaudeAgentSdk> | null = null

export function loadClaudeAgentSdk(): Promise<typeof ClaudeAgentSdk> {
  claudeAgentSdk ??= import('@anthropic-ai/claude-agent-sdk')
  return claudeAgentSdk
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function withoutKeys(env: Record<string, string>, keys: readonly string[]): Record<string, string> {
  for (const key of keys) {
    delete env[key]
  }
  return env
}

export type ClaudeStreamJsonConnection = ClaudeControlSurface & {
  readonly pid: number | undefined
  readonly closed: boolean
  /** What the ladder has observed so far; read after a `close()` that returned false. */
  readonly exitVerdict: ClaudeChildExitVerdict
  /** The CLI's executable was not found; a start that failed for it says so. */
  readonly executableMissing?: boolean
  pauseReading?: () => void
  resumeReading?: () => void
  send: (message: Record<string, unknown>, beforeDispatch?: () => Promise<void>) => Promise<void>
  /** Resolves true after processless settlement, or root exit plus observed tree exit. */
  close: () => Promise<boolean>
}

export async function openClaudeStreamJsonConnection(
  launch: ClaudeStreamJsonLaunch,
  handlers: ClaudeStreamJsonConnectionHandlers = {},
  spawnImpl: PipedProcessSpawner = spawnProcess,
  queryImpl?: typeof ClaudeAgentSdk.query
): Promise<ClaudeStreamJsonConnection> {
  const { query } = await loadClaudeAgentSdk()
  const protectedSeal = protectedClaudeSealForLaunch(launch)
  const spawner = createClaudeCodeProcessSpawn(spawnImpl, process.platform, protectedSeal)
  const inbox = createClaudeUserMessageQueue()
  const session = (queryImpl ?? query)({
    prompt: inbox.messages,
    options: {
      ...launch.options,
      cwd: launch.cwd,
      // Why env is never omitted: the SDK inherits process.env when it is, which is
      // exactly the ambient ANTHROPIC_* auth leak this lane already shipped once.
      // Orca's own CLAUDE_CONFIG_DIR is dropped for the same reason the launch drops the
      // shell's: the record's pin in `launch.env` must be the only home the child sees.
      env: protectedSeal
        ? protectedClaudeProcessEnvironment(protectedSeal)
        : withoutKeys(
            buildClaudeChildProcessEnv(launch.env, {
              inheritedEnv: withoutInheritedClaudeConfigDir(process.env),
              scrubConfiguredChildSessionStamps: true
            }),
            launch.envToDelete ?? []
          ),
      pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable,
      spawnClaudeCodeProcess: spawner.spawn,
      ...(protectedSeal
        ? { canUseTool: denyProtectedClaudeTool }
        : handlers.canUseTool
          ? { canUseTool: handlers.canUseTool }
          : {}),
      ...(handlers.onUserDialog && !protectedSeal ? { onUserDialog: handlers.onUserDialog } : {})
    }
  })
  const managed = spawner.managed
  const child = managed?.child
  if (!child || !managed) {
    throw new Error('the claude agent SDK returned without spawning a child')
  }
  let exitStatus: ClaudeExitStatus | null = null
  let closing = false
  let terminalError: Error | null = null
  let faultReported = false
  let exitReported = false
  let closePromise: Promise<boolean> | null = null
  let readingBarrier: Promise<void> | null = null
  let releaseReadingBarrier: (() => void) | null = null
  const pauseReading = (): void => {
    if (closing || managed.rootVerdict === 'exited' || terminalError || readingBarrier) {
      return
    }
    readingBarrier = new Promise<void>((resolve) => {
      releaseReadingBarrier = resolve
    })
  }
  const resumeReading = (): void => {
    const release = releaseReadingBarrier
    readingBarrier = null
    releaseReadingBarrier = null
    release?.()
  }
  const waitUntilReadable = (): Promise<void> => readingBarrier ?? Promise.resolve()
  // One reaper per child: every close attempt and error-path reap shares its proof.
  const rootSettled = (): boolean => managed.rootVerdict === 'exited'
  const tree = createClaudeChildTreeReaper(child, { exited: rootSettled })

  // Arm lazily on actual child output instead of issuing a process-table scan for
  // every session at startup. A natural SDK exit can race a later close, while
  // output-triggered observation still catches the usual live-child window.
  let outputObservationArmed = false
  const armTreeOnOutput = (): void => {
    if (outputObservationArmed) {
      return
    }
    outputObservationArmed = true
    void (tree.refresh?.() ?? tree.capture())
  }
  child.stderr.on('data', armTreeOnOutput)
  // The SDK may synchronously spawn the CLI and consume an early stderr chunk
  // before this connection can attach its listener; the bounded tail preserves
  // that observation for the same lazy arm.
  if (managed.stderrTail().length > 0) {
    armTreeOnOutput()
  }

  const handleUnexpectedEnd = (cause?: Error): void => {
    resumeReading()
    if (!terminalError) {
      const error = claudeStreamJsonExitError(managed.stderrTail(), exitStatus, cause)
      terminalError = managed.executableMissing ? withMissingProviderExecutable(error) : error
    }
    inbox.fail(terminalError)
    if (!closing && !faultReported) {
      faultReported = true
      handlers.onFault?.(terminalError)
    }
    if (managed.rootExitObserved && !exitReported) {
      exitReported = true
      handlers.onExit?.(terminalError, { expected: closing })
    }
  }

  const protectedGate = protectedSeal
    ? createProtectedClaudeTransportGate({
        session,
        pinnedModel: launch.options.model,
        fault: (error) => {
          terminalError ??= error
          handleUnexpectedEnd(error)
          void close()
        }
      })
    : null

  const readerDone = (async () => {
    try {
      const iterator = session[Symbol.asyncIterator]()
      let completed = false
      try {
        for (;;) {
          await waitUntilReadable()
          const next = await iterator.next()
          if (next.done) {
            completed = true
            break
          }
          await waitUntilReadable()
          if (!isRecord(next.value)) {
            throw new Error('claude stream-json yielded a non-object message')
          }
          if (!protectedGate || protectedGate.accept(next.value)) {
            handlers.onMessage?.(next.value)
          }
        }
      } finally {
        if (!completed) {
          await iterator.return?.()
        }
      }
    } catch (error: unknown) {
      // The SDK ends its generator in error when the child dies or the transport
      // fails; a transport failure with a live child still has to reap the tree.
      if (!closing && managed.rootVerdict !== 'exited') {
        void tree.reap()
      }
      handleUnexpectedEnd(error instanceof Error ? error : new Error(String(error)))
    }
  })()

  managed.onExit((exit) => {
    exitStatus = exit
    handleUnexpectedEnd()
  })
  child.on('error', (error) => {
    if (!closing && managed.rootVerdict !== 'exited') {
      void tree.reap()
    }
    handleUnexpectedEnd(error)
  })
  child.on('close', () => {
    handleUnexpectedEnd()
  })
  child.stdin.on('error', (error) => {
    if (!closing) {
      void tree.reap()
      handleUnexpectedEnd(error)
    }
  })

  const send: ClaudeStreamJsonConnection['send'] = (message, beforeDispatch) => {
    if (
      closing ||
      managed.rootVerdict === 'exited' ||
      terminalError ||
      child.stdin.destroyed ||
      !child.stdin.writable
    ) {
      return Promise.reject(
        claudeUnwrittenUserMessageError(
          terminalError ?? new Error('claude stream-json connection is closed')
        )
      )
    }
    if (protectedGate) {
      const held = protectedGate.dispatch(message, beforeDispatch)
      return inbox.push(claudeSdkUserMessage(held.message), held.beforeDispatch)
    }
    return inbox.push(claudeSdkUserMessage(message), beforeDispatch)
  }

  const close = (): Promise<boolean> => {
    closePromise ??= (async () => {
      closing = true
      protectedGate?.cancel()
      resumeReading()
      // Arm the descendant proof before the stop. The root may exit immediately;
      // a post-exit walk cannot recover descendants that reparented.
      await (tree.refresh?.() ?? tree.capture())
      inbox.end()
      const proven = await proveClaudeChildExit({
        tree,
        managed
      })
      inbox.fail(new Error('claude stream-json connection closed'))
      if (!proven) {
        if (managed.lastCloseResult?.root === 'exited' && managed.lastCloseResult.tree === 'live') {
          console.warn('[claude-stream-json] root exited but a descendant survived the close:', {
            pid: spawner.pid
          })
        }
        closePromise = null
        return false
      }
      const drained = await withTimeout(
        readerDone.then(() => true),
        CLAUDE_READER_DRAIN_AFTER_EXIT_MS,
        false
      )
      if (!drained) {
        console.warn('[claude-stream-json] output still open after the proven exit:', {
          pid: spawner.pid
        })
      }
      return true
    })()
    return closePromise
  }

  return {
    ...(protectedGate
      ? protectedGate.controls(createClaudeControlSurface(session))
      : createClaudeControlSurface(session)),
    get pid() {
      return spawner.pid
    },
    get closed() {
      return closing || managed.rootVerdict === 'exited' || terminalError !== null
    },
    get executableMissing() {
      return managed.executableMissing
    },
    get exitVerdict() {
      return {
        root: managed.rootVerdict,
        tree: tree.treeVerdict,
        ...(managed.processless ? { processless: true } : {})
      } as const
    },
    pauseReading,
    resumeReading,
    send,
    close
  }
}

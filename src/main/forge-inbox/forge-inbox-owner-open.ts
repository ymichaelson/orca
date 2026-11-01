import { existsSync } from 'node:fs'
import Database from '../sqlite/sync-database'
import {
  ForgeInboxOwnerMismatchError,
  ForgeInboxOwnerNotRunningError
} from './forge-inbox-owner-errors'
import type { ForgeOwnerRunning } from './forge-inbox-owner-running'
import type { ForgeOwnerServicePhase } from './forge-inbox-owner-service-status'

const WORK_LEFT_BY_AN_EARLIER_PROCESS = `SELECT 1 AS found FROM webhook_deliveries d
    WHERE d.host_id = ? AND d.finished_at IS NULL AND (
      d.decision_state IN ('queued', 'retry', 'processing') OR d.decision_token IS NOT NULL
      OR d.action_state IN ('processing', 'retry') OR d.action_token IS NOT NULL)
  UNION ALL SELECT 1 FROM project_event_questions q WHERE q.host_id = ? AND q.status = 'open'
  UNION ALL SELECT 1 FROM run_dispatch_confirmations c WHERE c.host_id = ? AND c.state = 'unconfirmed'
  LIMIT 1`

/**
 * Work an earlier process left: a delivery to decide or perform, a dispatch to confirm, a question.
 * Nothing commits on a dormant ledger, so a row on disk is the only hint that there is work.
 */
export function forgeLedgerHasWorkOnOpen(dbPath: string, hostId: string): boolean {
  if (!existsSync(dbPath)) {
    return false
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    return db.prepare(WORK_LEFT_BY_AN_EARLIER_PROCESS).get(hostId, hostId, hostId) !== undefined
  } finally {
    db.close()
  }
}

/**
 * The ledger opens at start when it may hold work, and lazily on a first write otherwise; an
 * unreadable ledger stays lazy so its failure surfaces on the first real use with its own code.
 */
export function forgeOwnerOpensOnStart(input: {
  dbPath: string
  receiverEnabled: boolean | undefined
  hasDecisionSource: boolean
  hostId: string
}): boolean {
  if (existsSync(input.dbPath) || input.receiverEnabled === true) {
    return true
  }
  if (!input.hasDecisionSource) {
    return false
  }
  try {
    return forgeLedgerHasWorkOnOpen(input.dbPath, input.hostId)
  } catch {
    return false
  }
}

export type ForgeOwnerOpenSteps = {
  /** The caller has checked there is no open state yet. */
  open: () => ForgeOwnerRunning
  opened: (state: ForgeOwnerRunning) => Promise<void>
  /** The open itself succeeded but its first reconcile failed, so the caller owns the teardown. */
  rejected: (state: ForgeOwnerRunning) => Promise<void>
  /** A stop or a failed open is final, which needs the caller's phase and receiver cleanup. */
  stop: () => void
}

/** Opens the ledger once: a stop or a failed open refuses every later caller, and callers share the one in flight. */
export function createForgeOwnerOpen(steps: ForgeOwnerOpenSteps) {
  let opening: Promise<ForgeOwnerRunning> | null = null
  return {
    open(
      running: () => ForgeOwnerRunning | null,
      phase: () => ForgeOwnerServicePhase
    ): Promise<ForgeOwnerRunning> {
      const state = running()
      if (state !== null) {
        return Promise.resolve(state)
      }
      if (phase() !== 'running') {
        return Promise.reject(new ForgeInboxOwnerNotRunningError())
      }
      return (opening ??= (async () => {
        let opened: ForgeOwnerRunning
        try {
          opened = steps.open()
        } catch (error) {
          steps.stop()
          throw error
        }
        try {
          await steps.opened(opened)
        } catch (error) {
          steps.stop()
          await steps.rejected(opened)
          throw error
        }
        return opened
      })())
    }
  }
}

/** A stop that landed while the open was reconciling must not let the caller use a closed ledger. */
export async function forgeOwnerReady(
  open: () => Promise<ForgeOwnerRunning>,
  running: () => ForgeOwnerRunning | null
): Promise<ForgeOwnerRunning> {
  const state = await open()
  if (running() !== state) {
    throw new ForgeInboxOwnerNotRunningError()
  }
  return state
}

/** After a lazy open and before any write, a ledger that appeared later may carry another owner id. */
export function fenced(
  state: ForgeOwnerRunning,
  expectedOwner: string | undefined
): ForgeOwnerRunning {
  if (expectedOwner !== undefined && state.ledger.hostId !== expectedOwner) {
    throw new ForgeInboxOwnerMismatchError()
  }
  return state
}

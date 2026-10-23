import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { ForgeInboxInvalidCursorError } from './forge-inbox-owner-errors'

export type ForgeCursorKey = ForgeInstanceScope & { readerId: string }

/** Reads for a possibly dormant owner: no ledger means no changes and no cursors. */
export function createForgeOwnerCursorReads(ledger: () => ForgeInboxLedger | null) {
  return {
    readChangeHead(scope: ForgeInstanceScope): number {
      return ledger()?.readChangeHead(scope) ?? 0
    },
    getClientCursor(key: ForgeCursorKey): number {
      return ledger()?.getClientCursor({ ...scopeOf(key), clientId: key.readerId }) ?? 0
    }
  }
}

/**
 * Moves one reader's cursor forward within the durable head; it never marks items read or touches
 * the change feed. Validation precedes the write so a rejected value leaves nothing behind.
 */
export function ackForgeClientCursor(
  ledger: ForgeInboxLedger | null,
  key: ForgeCursorKey & { seq: number }
): number {
  const head = ledger?.readChangeHead(scopeOf(key)) ?? 0
  if (!Number.isSafeInteger(key.seq) || key.seq < 0 || key.seq > head) {
    throw new ForgeInboxInvalidCursorError()
  }
  if (!ledger || key.seq === 0) {
    return ledger?.getClientCursor({ ...scopeOf(key), clientId: key.readerId }) ?? 0
  }
  ledger.setClientCursor({ ...scopeOf(key), clientId: key.readerId, lastSeq: key.seq })
  return ledger.getClientCursor({ ...scopeOf(key), clientId: key.readerId })
}

function scopeOf(key: ForgeCursorKey): ForgeInstanceScope {
  return key.instanceId === undefined ? {} : { instanceId: key.instanceId }
}

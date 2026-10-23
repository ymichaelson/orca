export const FORGE_INBOX_OWNER_NOT_RUNNING = 'forge-inbox-owner-not-running'

/** Thrown for any ledger-backed operation outside the running phase; a stopped or failed-start service is final. */
export class ForgeInboxOwnerNotRunningError extends Error {
  readonly code = FORGE_INBOX_OWNER_NOT_RUNNING

  constructor() {
    super('forge inbox owner service is not running; a stopped or failed-start service is final')
    this.name = 'ForgeInboxOwnerNotRunningError'
  }
}

/** The ledger a deferred first open reached belongs to a different owner than the caller addressed. */
export class ForgeInboxOwnerMismatchError extends Error {
  constructor() {
    super('forge inbox owner mismatch')
    this.name = 'ForgeInboxOwnerMismatchError'
  }
}

/** A cursor acknowledgement that is not a safe non-negative integer at or below the durable change head. */
export class ForgeInboxInvalidCursorError extends Error {
  constructor() {
    super('forge inbox cursor must be a safe integer no greater than the change head')
    this.name = 'ForgeInboxInvalidCursorError'
  }
}

import type Database from '../../sqlite/sync-database'
import { journalPragmaNumber } from './journal-database'
import { JOURNAL_DB_PROTECTED_RECORD_VERSION } from './journal-database-schema'

/** Runs inside the caller's open transaction, so the version rolls back with the record rows. */
export function raiseJournalVersionForProtectedRecords(db: Database.Database): void {
  if (!db.isTransaction) {
    throw new Error('the protected record version must be raised inside an open transaction')
  }
  if (journalPragmaNumber(db, 'user_version') < JOURNAL_DB_PROTECTED_RECORD_VERSION) {
    db.pragma(`user_version = ${JOURNAL_DB_PROTECTED_RECORD_VERSION}`)
  }
}

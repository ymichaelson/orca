import type { ForgeInboxErrorSource } from './forge-inbox-error-source'

/**
 * One state per Inbox item, derived on the host from durable rows. Read is not handling: an item
 * stays here until the work actually ends, and an unknown remote result is never shown as success.
 */
export const FORGE_ITEM_HANDLING_STATES = [
  'recorded',
  'processing',
  'waiting',
  'needs-user',
  'done',
  'failed',
  'unconfirmed'
] as const
export type ForgeItemHandlingState = (typeof FORGE_ITEM_HANDLING_STATES)[number]

export type ForgeItemHandlingView = {
  state: ForgeItemHandlingState
  /** Host-written code for a failed step; detail still carries the full run reason. */
  errorCode: string | null
  errorSource?: ForgeInboxErrorSource
  /** Optional so an older host's view still parses; set while a run is still running after a stop was asked for. */
  stopping?: true
}

import type { ForgeInstanceScope, ForgeReceipt } from '../../shared/forge-inbox-types'
import {
  forgeCommentBodyWithMarker,
  forgeCommentMarker,
  hashForgeCommentDraft,
  parseForgeCommentDraft,
  type ForgeCommentDraft,
  type ForgeCommentTarget
} from './forge-inbox-comment-draft'
import type { ForgeInboxLedger } from './forge-inbox-ledger'

/** A create-note response. `mayHaveLanded` must be false only when the forge proved it wrote nothing. */
export type ForgeCommentPost =
  | { ok: true; noteId: number | null }
  | { ok: false; code: string; mayHaveLanded: boolean }

export type ForgeCommentPoster = (
  request: { target: ForgeCommentTarget; body: string },
  signal: AbortSignal
) => Promise<ForgeCommentPost>

/** `complete` asserts the listing covered every note on the item; only then is absence evidence. */
export type ForgeCommentMarkerLookup =
  | { ok: true; noteIds: number[]; complete: boolean }
  | { ok: false; code: string }

export type ForgeCommentNoteFinder = (
  request: { target: ForgeCommentTarget; marker: string },
  signal: AbortSignal
) => Promise<ForgeCommentMarkerLookup>

export type ForgeCommentPublishResult =
  | { kind: 'published'; receiptId: number; noteId: number | null }
  | { kind: 'failed'; receiptId: number; reason: string }
  | { kind: 'unknown'; receiptId: number; reason: ForgeCommentUnknownReason }
  | { kind: 'refused'; reason: ForgeCommentPublishRefusal }

export type ForgeCommentUnknownReason =
  | 'delivery-unconfirmed'
  | 'marker-ambiguous'
  | 'marker-not-found'
  | 'marker-unavailable'

export type ForgeCommentPublishRefusal =
  | 'not-found'
  | 'not-approved'
  | 'not-a-comment'
  | 'draft-mismatch'
  | 'not-authorised'

/**
 * Publishes one approved comment. A receipt is written before the forge call, so a crash or an
 * ambiguous response is reconciled by the unique marker instead of replaying the write.
 */
export async function publishForgeComment(
  deps: {
    ledger: Pick<ForgeInboxLedger, 'getProposal' | 'getItem' | 'beginReceipt' | 'finishReceipt'>
    post: ForgeCommentPoster
    findNotes: ForgeCommentNoteFinder
  },
  input: { scope: ForgeInstanceScope; proposalId: number; expectedHash: string },
  signal: AbortSignal
): Promise<ForgeCommentPublishResult> {
  const proposal = deps.ledger.getProposal(input.proposalId)
  if (!proposal) {
    return { kind: 'refused', reason: 'not-found' }
  }
  const draft = parseForgeCommentDraft(proposal.body)
  if (!draft) {
    return { kind: 'refused', reason: 'not-a-comment' }
  }
  if (hashForgeCommentDraft(draft) !== input.expectedHash) {
    return { kind: 'refused', reason: 'draft-mismatch' }
  }
  if (!deps.ledger.getItem(input.scope, proposal.itemId)) {
    return { kind: 'refused', reason: 'not-found' }
  }
  if (proposal.status !== 'consumed') {
    return { kind: 'refused', reason: 'not-approved' }
  }

  const begun = deps.ledger.beginReceipt({ proposalId: input.proposalId })
  if (!begun.receipt) {
    return { kind: 'refused', reason: 'not-authorised' }
  }
  if (!begun.started) {
    return settled(begun.receipt)
  }

  const marker = forgeCommentMarker(input.proposalId, input.expectedHash)
  if (signal.aborted) {
    return finish(deps, begun.receipt.id, {
      state: 'failed',
      result: { code: 'cancelled' }
    })
  }
  const posted = await deps.post(
    { target: draft.target, body: forgeCommentBodyWithMarker(draft, marker) },
    signal
  )
  if (posted.ok) {
    return finish(deps, begun.receipt.id, {
      state: 'applied',
      result: { noteId: posted.noteId, marker }
    })
  }
  if (!posted.mayHaveLanded) {
    return finish(deps, begun.receipt.id, { state: 'failed', result: { code: posted.code } })
  }
  return reconcile(deps, begun, draft, marker, signal)
}

/** An existing receipt means the write may already have landed; report it, never repeat it. */
function settled(receipt: ForgeReceipt): ForgeCommentPublishResult {
  if (receipt.state === 'applied') {
    return {
      kind: 'published',
      receiptId: receipt.id,
      noteId: readNumber(receipt.result, 'noteId')
    }
  }
  if (receipt.state === 'failed') {
    return { kind: 'failed', receiptId: receipt.id, reason: readText(receipt.result, 'code') }
  }
  return { kind: 'unknown', receiptId: receipt.id, reason: 'delivery-unconfirmed' }
}

async function reconcile(
  deps: {
    ledger: Pick<ForgeInboxLedger, 'finishReceipt'>
    findNotes: ForgeCommentNoteFinder
  },
  begun: { receipt: ForgeReceipt },
  draft: ForgeCommentDraft,
  marker: string,
  signal: AbortSignal
): Promise<ForgeCommentPublishResult> {
  const lookup = await deps.findNotes({ target: draft.target, marker }, signal)
  if (!lookup.ok) {
    return finish(deps, begun.receipt.id, {
      state: 'unknown',
      result: { code: 'marker-unavailable', lookupCode: lookup.code }
    })
  }
  if (lookup.noteIds.length === 1) {
    return finish(deps, begun.receipt.id, {
      state: 'applied',
      result: { noteId: lookup.noteIds[0], marker, reconciled: true }
    })
  }
  const reason: ForgeCommentUnknownReason =
    lookup.noteIds.length > 1
      ? 'marker-ambiguous'
      : lookup.complete
        ? 'marker-not-found'
        : 'delivery-unconfirmed'
  return finish(deps, begun.receipt.id, {
    state: 'unknown',
    result: { code: reason, matches: lookup.noteIds.length }
  })
}

function finish(
  deps: {
    ledger: Pick<ForgeInboxLedger, 'finishReceipt'>
  },
  receiptId: number,
  outcome: { state: 'applied' | 'failed' | 'unknown'; result: unknown }
): ForgeCommentPublishResult {
  deps.ledger.finishReceipt(receiptId, outcome)
  if (outcome.state === 'applied') {
    return { kind: 'published', receiptId, noteId: readNumber(outcome.result, 'noteId') }
  }
  if (outcome.state === 'failed') {
    return { kind: 'failed', receiptId, reason: readText(outcome.result, 'code') }
  }
  return {
    kind: 'unknown',
    receiptId,
    reason: readUnknownReason(outcome.result)
  }
}

function readNumber(value: unknown, key: string): number | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const field = Reflect.get(value, key)
  return typeof field === 'number' && Number.isSafeInteger(field) ? field : null
}

function readText(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null) {
    return 'unknown'
  }
  const field = Reflect.get(value, key)
  return typeof field === 'string' ? field : 'unknown'
}

function readUnknownReason(value: unknown): ForgeCommentUnknownReason {
  const code = readText(value, 'code')
  return code === 'marker-ambiguous' || code === 'marker-not-found' || code === 'marker-unavailable'
    ? code
    : 'delivery-unconfirmed'
}

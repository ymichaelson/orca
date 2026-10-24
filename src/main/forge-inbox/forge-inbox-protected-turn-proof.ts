import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../shared/agent-session-journal-producer'
import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle,
  AgentJournalTurnOutcome
} from '../../shared/agent-session-journal-types'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../shared/agent-session-turn-record'
import type { ForgeProtectedSessionTurnHost } from './forge-inbox-protected-session-turn'

export const FORGE_PROTECTED_REPLY_MAX_BYTES = 256 * 1024
export const FORGE_PROTECTED_REPLY_MAX_PAGES = 4
export const FORGE_PROTECTED_REPLY_PAGE_ITEMS = 100
const REPLY_SCAN_MAX_BYTES = 1024 * 1024
const REPLY_SCAN_MAX_ITEMS = FORGE_PROTECTED_REPLY_MAX_PAGES * FORGE_PROTECTED_REPLY_PAGE_ITEMS

export type ForgeProtectedTurnProof = {
  turnId: string
  terminal: boolean
  outcome: AgentJournalTurnOutcome | null
  text: string | null
}

/** Follows the send's own submission key into the one turn that names it, then reads only that
 *  turn's root assistant rows. Reduced, byte-bounded pages; anything unprovable reads as null. */
export async function readForgeProtectedTurnProof(
  host: Pick<ForgeProtectedSessionTurnHost, 'history'>,
  sessionId: string,
  clientMessageId: string
): Promise<ForgeProtectedTurnProof | null> {
  const submissionKey = agentJournalSubmissionKey(clientMessageId)
  const items = new Map<string, AgentJournalRenderItem>()
  const submissions = new Map<string, AgentJournalSubmission>()
  let cursor: AgentJournalCursor | undefined
  let liveCursor: AgentJournalCursor | undefined
  let scanned = false
  let bytes = 0
  for (let index = 0; index < FORGE_PROTECTED_REPLY_MAX_PAGES; index++) {
    const result = await host.history(
      {
        sessionId,
        direction: cursor ? 'before' : 'tail',
        ...(cursor ? { cursor } : {}),
        limit: FORGE_PROTECTED_REPLY_PAGE_ITEMS
      },
      'own-agent'
    )
    if (!result.ok || result.page.sessionId !== sessionId) {
      return null
    }
    const page = result.page
    // Every page must describe the same journal head: a snapshot that moved between reads could
    // pair an older tail with a newer terminal row and a partial reply.
    const head = page.liveCursor
    if (
      !head ||
      head.epoch !== page.epoch ||
      (liveCursor !== undefined &&
        (liveCursor.epoch !== head.epoch || liveCursor.sequence !== head.sequence))
    ) {
      return null
    }
    liveCursor = head
    bytes += Buffer.byteLength(JSON.stringify(page.items), 'utf8')
    if (bytes > REPLY_SCAN_MAX_BYTES || items.size + page.items.length > REPLY_SCAN_MAX_ITEMS) {
      return null
    }
    for (const item of page.items) {
      if (items.has(item.itemId)) {
        return null
      }
      items.set(item.itemId, item)
    }
    for (const submission of page.submissions) {
      submissions.set(submission.clientMessageId, submission)
    }
    if (!page.hasOlder) {
      scanned = true
      break
    }
    const next = page.window.nextCursor
    if (next.epoch !== head.epoch || (cursor && next.sequence >= cursor.sequence)) {
      return null
    }
    // A turn naming this send cannot predate the send's own row, so once pagination passes that
    // row's sequence no older page can hold a second matching turn.
    const submittedSequence = submissions.get(clientMessageId)?.submittedSequence
    if (submittedSequence !== undefined && next.sequence <= submittedSequence) {
      scanned = true
      break
    }
    cursor = next
  }
  // A window cut off by the page cap cannot prove there is no second matching turn.
  if (!scanned) {
    return null
  }
  return proveReply(items, submissionKey, submissions.get(clientMessageId)?.providerItemId)
}

function proveReply(
  items: ReadonlyMap<string, AgentJournalRenderItem>,
  submissionKey: string,
  providerItemId: string | null | undefined
): ForgeProtectedTurnProof | null {
  // An echo-opened turn names the provider's own user row; the dispatch row maps that row to the
  // submission. An assistant-first turn names the submission key outright.
  const openerIds = new Set([submissionKey, ...(providerItemId ? [providerItemId] : [])])
  const matches: { itemId: string; turn: AgentJournalTurnLifecycle }[] = []
  for (const item of items.values()) {
    if (item.shortened || !isRootAgentJournalItem(item)) {
      continue
    }
    const turn = readAgentJournalTurn(item.body)
    if (turn?.userItemId !== undefined && openerIds.has(turn.userItemId)) {
      matches.push({ itemId: item.itemId, turn })
    }
  }
  // A second turn naming the same send makes attribution ambiguous, so neither may be claimed.
  if (matches.length !== 1) {
    return null
  }
  const [{ itemId, turn }] = matches
  const terminal = turn.state === 'completed' || turn.state === 'interrupted'
  return {
    turnId: turn.turnId,
    terminal,
    outcome: readAgentJournalTurnOutcome(turn),
    text: terminal ? readTurnText(items, itemId) : null
  }
}

function readTurnText(
  items: ReadonlyMap<string, AgentJournalRenderItem>,
  turnItemId: string
): string | null {
  const text: string[] = []
  let bytes = 0
  const ordered = [...items.values()].sort(
    (a, b) => a.sequence - b.sequence || (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0)
  )
  for (const entry of ordered) {
    if (
      !isRootAgentJournalItem(entry) ||
      entry.turnScope?.kind !== 'turn' ||
      entry.turnScope.turnItemId !== turnItemId ||
      entry.body.kind !== 'message' ||
      entry.body.role !== 'assistant'
    ) {
      continue
    }
    if (entry.shortened) {
      return null
    }
    for (const block of entry.body.blocks) {
      if (block.type !== 'text') {
        continue
      }
      bytes += Buffer.byteLength(block.text, 'utf8') + (text.length > 0 ? 1 : 0)
      if (bytes > FORGE_PROTECTED_REPLY_MAX_BYTES) {
        return null
      }
      text.push(block.text)
    }
  }
  const reply = text.join('\n')
  return reply.trim() === '' ? null : reply
}

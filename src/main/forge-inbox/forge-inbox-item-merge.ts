import type { ForgeInstanceScope, ForgeItem } from '../../shared/forge-inbox-types'
import type { ForgeItemMergeOutcome } from '../../shared/forge-inbox-rpc-types'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { recordForgeChange } from './forge-inbox-context'
import type { DispatchRecommendationAction } from './forge-inbox-dispatch-report'
import { readStoredDispatchReport } from './forge-inbox-dispatch-report'
import type { ForgeMergePort } from './forge-inbox-gitlab-merge'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { rowNumber } from './forge-inbox-rows'

export type ItemRecommendation = {
  runId: number
  action: DispatchRecommendationAction
  /** The head the agent reviewed; the merge is bound to exactly this commit. */
  expectedSha: string | null
}

/** The newest dispatched run that reported a recommendation; older runs never vote. */
export function readLatestDispatchRecommendation(
  ctx: ForgeLedgerContext,
  itemId: number
): ItemRecommendation | null {
  const row = ctx.db
    .prepare(
      `SELECT c.run_id, c.expected_sha, c.report_json
       FROM run_dispatch_confirmations c JOIN runs r ON r.id = c.run_id
       WHERE c.host_id = ? AND r.item_id = ?
       ORDER BY c.run_id DESC LIMIT 1`
    )
    .get(ctx.hostId, itemId)
  if (row === undefined) {
    return null
  }
  const report = readStoredDispatchReport(
    typeof row.report_json === 'string' ? row.report_json : null
  )
  const advised = report.status === 'claims' ? (report.recommendation ?? null) : null
  if (advised === null) {
    return null
  }
  return {
    runId: rowNumber(row, 'run_id'),
    action: advised.action,
    expectedSha: typeof row.expected_sha === 'string' ? row.expected_sha : null
  }
}

/**
 * Executes only what the latest run recommended: the person confirmed that exact action, so the
 * host refuses to merge anything else, and it merges the reviewed commit, never whatever is newest.
 */
export async function mergeForgeItem(
  deps: {
    ledger: Pick<ForgeInboxLedger, 'getItem' | 'ledgerContext'>
    merge: ForgeMergePort['merge']
  },
  input: { scope: ForgeInstanceScope; itemId: number },
  signal: AbortSignal
): Promise<ForgeItemMergeOutcome> {
  const item = deps.ledger.getItem(input.scope, input.itemId)
  if (item === null) {
    return { ok: false, reason: 'not-found' }
  }
  if (item.kind !== 'merge_request') {
    return { ok: false, reason: 'not-a-merge-request' }
  }
  if (item.state !== 'opened') {
    return { ok: false, reason: 'not-open' }
  }
  const recommendation = readLatestDispatchRecommendation(deps.ledger.ledgerContext(), item.id)
  if (recommendation === null) {
    return { ok: false, reason: 'no-recommendation' }
  }
  if (recommendation.action !== 'merge') {
    return { ok: false, reason: 'not-recommended' }
  }
  if (recommendation.expectedSha === null) {
    return { ok: false, reason: 'no-expected-sha' }
  }
  const result = await deps.merge(mergeTargetOf(item), recommendation.expectedSha, signal)
  recordForgeChange(
    deps.ledger.ledgerContext(),
    item.id,
    'run',
    recommendation.runId,
    result.ok ? 'merge-applied' : 'merge-failed'
  )
  return result.ok ? { ok: true } : { ok: false, reason: result.code }
}

function mergeTargetOf(item: ForgeItem) {
  return {
    instanceId: item.instanceId,
    projectId: item.projectId,
    kind: 'merge_request' as const,
    iid: item.iid
  }
}

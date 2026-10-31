import {
  FORGE_DISPATCH_CLAIM_ATTRIBUTIONS,
  FORGE_DISPATCH_CLAIM_OUTCOMES,
  FORGE_DISPATCH_CONFIRMATION_CODES,
  FORGE_DISPATCH_CONFIRMATION_STATES,
  type ForgeDispatchClaimAttribution,
  type ForgeDispatchClaimOutcome,
  type ForgeDispatchConfirmationClaimView,
  type ForgeDispatchConfirmationView
} from '../../shared/forge-inbox-dispatch-confirmation'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { readStoredDispatchReport } from './forge-inbox-dispatch-report'
import { isRecord, rowNumber, rowText } from './forge-inbox-rows'

function parseRecord(json: string | null): Record<string, unknown> {
  if (json === null) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(json)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function oneOf<T extends string>(options: readonly T[], value: unknown): T | undefined {
  return options.find((option) => option === value)
}

type CheckedClaim = {
  outcome: ForgeDispatchClaimOutcome | undefined
  attribution: ForgeDispatchClaimAttribution | undefined
}

/** Only a marker comment proves who wrote it; any other, or unknown, attribution is state alone. */
function attributionOf(value: unknown): ForgeDispatchClaimAttribution | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  return oneOf(FORGE_DISPATCH_CLAIM_ATTRIBUTIONS, value) ?? 'state-only'
}

function checkedClaims(evidence: Record<string, unknown>): CheckedClaim[] {
  const claims = Array.isArray(evidence.claims) ? evidence.claims : []
  return claims.map((claim) => {
    const record = isRecord(claim) ? claim : {}
    return {
      outcome: oneOf(FORGE_DISPATCH_CLAIM_OUTCOMES, record.outcome),
      attribution: attributionOf(record.attribution)
    }
  })
}

/**
 * Builds the client's view from fixed vocabularies only: the report supplies the claimed
 * kind and number, the evidence the verdict, and nothing else the agent or GitLab wrote survives.
 */
export function dispatchConfirmationView(row: {
  state: string
  reportJson: string | null
  evidenceJson: string | null
}): ForgeDispatchConfirmationView | null {
  const state = oneOf(FORGE_DISPATCH_CONFIRMATION_STATES, row.state)
  if (state === undefined) {
    return null
  }
  const evidence = parseRecord(row.evidenceJson)
  const report = readStoredDispatchReport(row.reportJson)
  const checked = checkedClaims(evidence)
  const reported = report.status === 'claims' && state !== 'no-claim' ? report.claims : []
  // Pairing is by position, so a count that does not match is shown as unchecked, not guessed.
  const paired = checked.length === reported.length
  const fallback: ForgeDispatchClaimOutcome =
    state === 'unconfirmable' ? 'unconfirmable' : 'unproven'
  const claims: ForgeDispatchConfirmationClaimView[] = reported.map((claim, index) => ({
    kind: claim.kind,
    target: claim.target.kind,
    iid: claim.target.iid,
    outcome: (paired ? checked[index]?.outcome : undefined) ?? fallback,
    attribution: (paired ? checked[index]?.attribution : undefined) ?? null
  }))
  const code = oneOf(FORGE_DISPATCH_CONFIRMATION_CODES, evidence.code)
  // The recommendation is what the agent thinks a person should do, not a claim about what it did.
  const advised = report.status === 'claims' ? (report.recommendation ?? null) : null
  const recommendation =
    state !== 'no-claim' && advised !== null
      ? { action: advised.action, reason: advised.reason }
      : undefined
  return {
    state,
    claims,
    checkedAt:
      typeof evidence.checkedAt === 'number' && Number.isFinite(evidence.checkedAt)
        ? evidence.checkedAt
        : null,
    ...(code === undefined ? {} : { code }),
    ...(recommendation === undefined ? {} : { recommendation })
  }
}

export function readDispatchConfirmationViews(
  ctx: ForgeLedgerContext,
  runIds: readonly number[]
): Map<number, ForgeDispatchConfirmationView> {
  const views = new Map<number, ForgeDispatchConfirmationView>()
  if (runIds.length === 0) {
    return views
  }
  const rows = ctx.db
    .prepare(
      `SELECT run_id, state, report_json, evidence_json FROM run_dispatch_confirmations
       WHERE host_id = ? AND run_id IN (SELECT value FROM json_each(?))`
    )
    .all(ctx.hostId, JSON.stringify(runIds))
  for (const row of rows) {
    const view = dispatchConfirmationView({
      state: rowText(row, 'state'),
      reportJson: typeof row.report_json === 'string' ? row.report_json : null,
      evidenceJson: typeof row.evidence_json === 'string' ? row.evidence_json : null
    })
    if (view) {
      views.set(rowNumber(row, 'run_id'), view)
    }
  }
  return views
}

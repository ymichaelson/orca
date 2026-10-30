import type { ComponentProps } from 'react'
import type { Badge } from '@/components/ui/badge'
import type {
  ForgeDispatchConfirmationClaimView,
  ForgeDispatchConfirmationCode,
  ForgeDispatchConfirmationView
} from '../../../../shared/forge-inbox-dispatch-confirmation'
import type { ForgeRunView } from '../../../../shared/forge-inbox-rpc-types'
import { translate } from '@/i18n/i18n'

const DISPATCH_RUN_REASON = 'project-event-dispatch'

function dispatchClaimActionLabel(kind: ForgeDispatchConfirmationClaimView['kind']): string {
  switch (kind) {
    case 'comment':
      return translate('auto.components.forge-inbox.display.dispatchClaimComment', 'Comment on')
    case 'approve':
      return translate('auto.components.forge-inbox.display.dispatchClaimApprove', 'Approval of')
    case 'merge':
      return translate('auto.components.forge-inbox.display.dispatchClaimMerge', 'Merge of')
    case 'unfinished':
      return translate(
        'auto.components.forge-inbox.display.dispatchClaimUnfinished',
        'Unfinished work on'
      )
  }
}

function dispatchClaimOutcomeLabel(outcome: ForgeDispatchConfirmationClaimView['outcome']): string {
  switch (outcome) {
    case 'confirmed':
      return translate(
        'auto.components.forge-inbox.display.dispatchOutcomeConfirmed',
        'found on GitLab'
      )
    case 'contradicted':
      return translate(
        'auto.components.forge-inbox.display.dispatchOutcomeContradicted',
        'GitLab shows otherwise'
      )
    case 'unproven':
      return translate(
        'auto.components.forge-inbox.display.dispatchOutcomeUnproven',
        'not found yet'
      )
    case 'unconfirmable':
      return translate(
        'auto.components.forge-inbox.display.dispatchOutcomeUnconfirmable',
        'cannot be checked'
      )
  }
}

/** An unsure agent's report is capped, so what GitLab matched is shown as reported, not as verified. */
export function forgeDispatchClaimLine(
  claim: ForgeDispatchConfirmationClaimView,
  capped = false
): string {
  const target =
    claim.target === 'merge_request'
      ? translate(
          'auto.components.forge-inbox.display.dispatchTargetMergeRequest',
          'merge request !{{iid}}',
          { iid: claim.iid }
        )
      : translate('auto.components.forge-inbox.display.dispatchTargetIssue', 'issue #{{iid}}', {
          iid: claim.iid
        })
  return translate(
    'auto.components.forge-inbox.display.dispatchClaimLine',
    '{{action}} {{target}}: {{outcome}}',
    {
      action: dispatchClaimActionLabel(claim.kind),
      target,
      outcome:
        capped && claim.outcome === 'confirmed'
          ? translate(
              'auto.components.forge-inbox.display.dispatchOutcomeReported',
              'reported, not verified'
            )
          : dispatchClaimOutcomeLabel(claim.outcome)
    }
  )
}

function dispatchCodeExplanation(code: ForgeDispatchConfirmationCode | undefined): string | null {
  switch (code) {
    case 'mode-unknown':
      return translate(
        'auto.components.forge-inbox.display.dispatchModeUnknown',
        'The agent was unsure what it changed, so its report is not verified.'
      )
    case 'report-missing':
    case 'report-ambiguous':
    case 'no-claims-reported':
      return translate(
        'auto.components.forge-inbox.display.dispatchReportUnreadable',
        'The agent did not give a readable report of its changes.'
      )
    case 'binding-changed':
      return translate(
        'auto.components.forge-inbox.display.dispatchBindingChanged',
        'The project connection changed, so GitLab was not checked.'
      )
    case 'deadline':
    case 'unproven':
      return translate(
        'auto.components.forge-inbox.display.dispatchNotConfirmedInTime',
        'GitLab did not confirm the changes in time.'
      )
    case 'agent-unfinished':
      return translate(
        'auto.components.forge-inbox.display.dispatchAgentUnfinished',
        'The agent said it left work unfinished.'
      )
    case 'unreported-comment':
      return translate(
        'auto.components.forge-inbox.display.dispatchUnreportedComment',
        'A comment from this agent was found that its report left out.'
      )
    case 'read-only-unchecked':
      return translate(
        'auto.components.forge-inbox.display.dispatchReadOnlyUnchecked',
        'The agent reported no changes, but GitLab could not be checked for stray comments.'
      )
    case 'off-target':
      return translate(
        'auto.components.forge-inbox.display.dispatchOffTarget',
        'The report names something other than this item.'
      )
    case 'no-expected-sha':
      return translate(
        'auto.components.forge-inbox.display.dispatchNoRevision',
        'No revision was recorded to check against.'
      )
    case 'sha-mismatch':
    case 'head-moved':
      return translate(
        'auto.components.forge-inbox.display.dispatchRevisionDiffers',
        'The revision on GitLab differs from the one the agent worked on.'
      )
    case 'merged-by-other':
    case 'not-approved':
    case 'not-merged':
    case 'read-only-report':
    case undefined:
      return null
  }
}

export type ForgeDispatchConfirmationDisplay = {
  label: string
  variant: ComponentProps<typeof Badge>['variant']
  lines: string[]
  explanation: string | null
  /** True when an approval or merge is shown by GitLab state alone, not tied to this agent. */
  stateOnly: boolean
}

/**
 * A run that dispatched an agent never reads as confirmed by default: a succeeded one from a host
 * that sent no verdict is unknown, and a send that never reached the agent says nothing at all.
 */
export function forgeDispatchConfirmationDisplay(
  run: Pick<ForgeRunView, 'state' | 'reason' | 'dispatchConfirmation'>
): ForgeDispatchConfirmationDisplay | null {
  const confirmation: ForgeDispatchConfirmationView | undefined = run.dispatchConfirmation
  if (confirmation === undefined) {
    return run.reason === DISPATCH_RUN_REASON && run.state === 'succeeded'
      ? {
          label: translate(
            'auto.components.forge-inbox.display.dispatchChangesUnknown',
            'Changes unknown'
          ),
          variant: 'outline',
          lines: [],
          explanation: null,
          stateOnly: false
        }
      : null
  }
  const capped = confirmation.state === 'unconfirmable' && confirmation.code === 'mode-unknown'
  const lines = confirmation.claims.map((claim) => forgeDispatchClaimLine(claim, capped))
  const stateOnly = confirmation.claims.some((claim) => claim.attribution === 'state-only')
  const explanation = dispatchCodeExplanation(confirmation.code)
  switch (confirmation.state) {
    case 'confirmed':
      return {
        label: stateOnly
          ? translate(
              'auto.components.forge-inbox.display.dispatchChangesStateOnly',
              'State matches on GitLab'
            )
          : translate(
              'auto.components.forge-inbox.display.dispatchChangesConfirmed',
              'Changes confirmed'
            ),
        variant: 'secondary',
        lines,
        explanation,
        stateOnly
      }
    case 'contradicted':
      return {
        label: translate(
          'auto.components.forge-inbox.display.dispatchChangesContradicted',
          'GitLab contradicts the report'
        ),
        variant: 'destructive',
        lines,
        explanation,
        stateOnly
      }
    case 'unconfirmable':
      return {
        label: translate(
          'auto.components.forge-inbox.display.dispatchChangesUnconfirmable',
          'Changes cannot be confirmed'
        ),
        variant: 'outline',
        lines,
        explanation,
        stateOnly
      }
    case 'unconfirmed':
      return {
        label: translate(
          'auto.components.forge-inbox.display.dispatchChangesUnconfirmed',
          'Changes not yet confirmed'
        ),
        variant: 'outline',
        lines,
        explanation,
        stateOnly
      }
    case 'no-claim':
      return confirmation.code === 'read-only-report'
        ? {
            label: translate(
              'auto.components.forge-inbox.display.dispatchNoRemoteChanges',
              'Agent reported no remote changes'
            ),
            variant: 'secondary',
            lines: [],
            explanation: null,
            stateOnly: false
          }
        : null
  }
}

import type { ComponentProps } from 'react'
import type { Badge } from '@/components/ui/badge'
import type { ForgeItemKind, ForgeRunState } from '../../../../shared/forge-inbox-types'
import type { ForgeInboxPhase } from '../../../../shared/forge-inbox-rpc-types'
import { translate } from '@/i18n/i18n'

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

export function formatForgeDateTime(value: number): string {
  return dateTimeFormatter.format(value)
}

export function forgeItemKindLabel(kind: ForgeItemKind): string {
  switch (kind) {
    case 'merge_request':
      return translate('auto.components.forge-inbox.display.kindMergeRequest', 'Merge request')
    case 'issue':
      return translate('auto.components.forge-inbox.display.kindIssue', 'Issue')
    case 'pipeline':
      return translate('auto.components.forge-inbox.display.kindPipeline', 'Pipeline')
  }
}

export function forgeRunStateLabel(state: ForgeRunState): string {
  switch (state) {
    case 'queued':
      return translate('auto.components.forge-inbox.display.runQueued', 'Queued')
    case 'running':
      return translate('auto.components.forge-inbox.display.runRunning', 'Running')
    case 'awaiting-approval':
      return translate(
        'auto.components.forge-inbox.display.runAwaitingApproval',
        'Awaiting approval'
      )
    case 'succeeded':
      return translate('auto.components.forge-inbox.display.runSucceeded', 'Succeeded')
    case 'failed':
      return translate('auto.components.forge-inbox.display.runFailed', 'Failed')
    case 'cancelled':
      return translate('auto.components.forge-inbox.display.runCancelled', 'Cancelled')
    case 'unverifiable':
      return translate('auto.components.forge-inbox.display.runUnverifiable', 'Needs checking')
    case 'superseded':
      return translate('auto.components.forge-inbox.display.runSuperseded', 'Superseded')
  }
}

export function forgeRunStateVariant(
  state: ForgeRunState
): ComponentProps<typeof Badge>['variant'] {
  if (state === 'succeeded') {
    return 'secondary'
  }
  if (state === 'failed') {
    return 'destructive'
  }
  if (state === 'cancelled' || state === 'superseded') {
    return 'outline'
  }
  return 'dot'
}

export function forgePhaseLabel(phase: ForgeInboxPhase | 'unattached'): string {
  switch (phase) {
    case 'unattached':
      return translate('auto.components.forge-inbox.display.phaseUnattached', 'Not available')
    case 'new':
      return translate('auto.components.forge-inbox.display.phaseNew', 'Not started')
    case 'running':
      return translate('auto.components.forge-inbox.display.phaseRunning', 'Running')
    case 'stopped':
      return translate('auto.components.forge-inbox.display.phaseStopped', 'Stopped')
  }
}

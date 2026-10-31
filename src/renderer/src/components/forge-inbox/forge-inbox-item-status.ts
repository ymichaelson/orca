import type { ComponentProps } from 'react'
import type { Badge } from '@/components/ui/badge'
import type { ForgeItemKind, ForgeRunState } from '../../../../shared/forge-inbox-types'
import type { ForgeItemHandlingView } from '../../../../shared/forge-inbox-item-handling'
import { translate } from '@/i18n/i18n'

/** GitLab's own state, in words that say what it means for the change rather than repeating `opened`. */
export function forgeItemStateLabel(kind: ForgeItemKind, state: string): string | null {
  if (kind === 'merge_request') {
    switch (state) {
      case 'opened':
        return translate('auto.components.forge-inbox.display.stateMrOpen', 'Not merged')
      case 'merged':
        return translate('auto.components.forge-inbox.display.stateMrMerged', 'Merged')
      case 'closed':
        return translate('auto.components.forge-inbox.display.stateMrClosed', 'Closed')
      case 'locked':
        return translate('auto.components.forge-inbox.display.stateMrLocked', 'Locked')
      default:
        return null
    }
  }
  if (kind === 'issue') {
    switch (state) {
      case 'opened':
        return translate('auto.components.forge-inbox.display.stateIssueOpen', 'Unresolved')
      case 'closed':
        return translate('auto.components.forge-inbox.display.stateIssueClosed', 'Resolved')
      default:
        return null
    }
  }
  return null
}

export type ForgeItemStatusTag = {
  label: string
  variant: ComponentProps<typeof Badge>['variant']
}

/**
 * What the agent did, named by the side that acted: an unfinished merge is the merge request's
 * state, never this item's failure. `handling` is absent from older hosts without a run state.
 */
export function forgeItemStatusTag(
  handling: ForgeItemHandlingView | undefined,
  latestRunState: ForgeRunState | null
): ForgeItemStatusTag | null {
  if (handling?.state === 'needs-user') {
    return {
      label: translate('auto.components.forge-inbox.display.statusNeedsUser', 'Waiting for you'),
      variant: 'default'
    }
  }
  switch (latestRunState) {
    case 'running':
    case 'queued':
      return {
        label: translate('auto.components.forge-inbox.display.statusAgentRunning', 'Agent running'),
        variant: 'dot'
      }
    case 'awaiting-approval':
      return {
        label: translate(
          'auto.components.forge-inbox.display.statusAwaitingApproval',
          'Waiting for your approval'
        ),
        variant: 'default'
      }
    case 'failed':
      return {
        label: translate(
          'auto.components.forge-inbox.display.statusAgentFailed',
          'Agent run failed'
        ),
        variant: 'destructive'
      }
    case 'cancelled':
      return {
        label: translate(
          'auto.components.forge-inbox.display.statusAgentCancelled',
          'Agent stopped'
        ),
        variant: 'outline'
      }
    case 'unverifiable':
      return {
        label: translate(
          'auto.components.forge-inbox.display.statusResultUnconfirmed',
          'Result unconfirmed'
        ),
        variant: 'outline'
      }
    case 'superseded':
      return {
        label: translate(
          'auto.components.forge-inbox.display.statusSuperseded',
          'Replaced by a newer version'
        ),
        variant: 'outline'
      }
    case 'succeeded':
      return {
        label: translate(
          'auto.components.forge-inbox.display.statusAgentSucceeded',
          'Agent run succeeded'
        ),
        variant: 'secondary'
      }
    case null:
    case undefined:
      break
  }
  if (handling === undefined) {
    return null
  }
  if (handling.state === 'failed') {
    return {
      label: translate(
        'auto.components.forge-inbox.display.statusHandlingFailed',
        'Handling failed'
      ),
      variant: 'destructive'
    }
  }
  if (handling.state === 'unconfirmed') {
    return {
      label: translate(
        'auto.components.forge-inbox.display.statusResultUnconfirmed',
        'Result unconfirmed'
      ),
      variant: 'outline'
    }
  }
  if (handling.state === 'processing') {
    return {
      label: translate('auto.components.forge-inbox.display.statusProcessing', 'Processing'),
      variant: 'dot'
    }
  }
  if (handling.state === 'waiting') {
    return {
      label: translate('auto.components.forge-inbox.display.statusWaiting', 'Waiting for changes'),
      variant: 'outline'
    }
  }
  if (handling.state === 'done') {
    return {
      label: translate('auto.components.forge-inbox.display.statusDone', 'Handled'),
      variant: 'secondary'
    }
  }
  return {
    label: translate('auto.components.forge-inbox.display.statusRecorded', 'Recorded'),
    variant: 'outline'
  }
}

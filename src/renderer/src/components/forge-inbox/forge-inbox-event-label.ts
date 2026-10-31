import type {
  ForgeEventFacts,
  ForgeEventSummary,
  ForgeItemKind
} from '../../../../shared/forge-inbox-types'
import { translate } from '@/i18n/i18n'
import { forgeItemKindLabel } from './forge-inbox-display'

const issueTriggers: Record<string, TriggerLabel> = {
  open: { name: 'issueOpened', text: 'Issue opened' },
  reopen: { name: 'issueOpened', text: 'Issue opened' },
  close: { name: 'issueClosed', text: 'Issue closed' },
  update: { name: 'issueUpdated', text: 'Issue updated' }
}

const mergeRequestTriggers: Record<string, TriggerLabel> = {
  open: { name: 'mrOpened', text: 'Merge request opened' },
  reopen: { name: 'mrOpened', text: 'Merge request opened' },
  approved: { name: 'mrApproved', text: 'Merge request approved' },
  approval: { name: 'mrApproved', text: 'Merge request approved' },
  merge: { name: 'mrMerged', text: 'Merge request merged' },
  close: { name: 'mrClosed', text: 'Merge request closed' },
  update: { name: 'mrUpdated', text: 'Merge request updated' }
}

type TriggerLabel = { name: string; text: string; params?: Record<string, string> }

/**
 * What happened in one hook, in words. Each delivery is its own item, so a bare event kind would
 * leave two updates of the same merge request indistinguishable.
 */
export function forgeEventLabel(
  kind: ForgeItemKind,
  eventKind: string,
  summary: ForgeEventSummary
): string {
  const trigger = forgeTriggerLabel(summary.facts, eventKind)
  if (trigger === null) {
    return eventKind
  }
  return translate('auto.components.forge-inbox.eventLabel.on', '{{trigger}} on {{kind}}', {
    trigger: translate(
      `auto.components.forge-inbox.eventLabel.${trigger.name}`,
      trigger.text,
      trigger.params
    ),
    kind: forgeItemKindLabel(kind)
  })
}

/** Unknown actions say which object they were about without inventing what happened. */
export function forgeEventTriggerLabel(
  facts: ForgeEventFacts | undefined,
  eventKind: string
): string {
  return forgeTriggerLabel(facts, eventKind)?.text ?? eventKind
}

function forgeTriggerLabel(
  facts: ForgeEventFacts | undefined,
  eventKind: string
): TriggerLabel | null {
  if (facts === undefined) {
    return fallbackTrigger(eventKind)
  }
  if (facts.kind === undefined) {
    return null
  }
  switch (facts.kind) {
    case 'merge_request':
      return mergeRequestTrigger(facts.action)
    case 'issue':
      return issueTriggers[facts.action ?? ''] ?? { name: 'issueEvent', text: 'Issue event' }
    case 'note':
      return { name: 'note', text: 'New comment' }
    case 'pipeline':
      return {
        name: 'pipeline',
        text: 'Pipeline {{status}}',
        params: { status: facts.status ?? '—' }
      }
    case 'push':
      return refTrigger('push', 'New commits', facts.ref)
    case 'tag_push':
      return refTrigger('tagPush', 'Tag pushed', facts.ref)
    case 'release':
      return {
        name: 'release',
        text: 'Release {{action}}',
        params: { action: facts.action ?? '—' }
      }
    case 'deployment':
      return {
        name: 'deployment',
        text: 'Deployment {{status}}',
        params: { status: facts.status ?? '—' }
      }
    default:
      return null
  }
}

function fallbackTrigger(eventKind: string): TriggerLabel | null {
  switch (eventKind) {
    case 'Note Hook':
      return { name: 'note', text: 'New comment' }
    case 'Issue Hook':
      return { name: 'issueEvent', text: 'Issue event' }
    case 'Merge Request Hook':
      return { name: 'mergeRequestEvent', text: 'Merge request event' }
    default:
      return null
  }
}

function mergeRequestTrigger(action: string | undefined): TriggerLabel {
  return (
    mergeRequestTriggers[action ?? ''] ?? { name: 'mergeRequestEvent', text: 'Merge request event' }
  )
}

function refTrigger(name: string, text: string, ref: string | undefined): TriggerLabel {
  return ref === undefined || ref === ''
    ? { name, text }
    : { name: `${name}On`, text: `${text} to {{ref}}`, params: { ref } }
}

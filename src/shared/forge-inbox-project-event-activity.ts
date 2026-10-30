import type { ForgeInboxErrorSource } from './forge-inbox-error-source'
import type { ForgeItemKind } from './forge-inbox-types'

export const PROJECT_EVENT_ACTIVITY_DEFAULT_LIMIT = 5
export const PROJECT_EVENT_ACTIVITY_MAX_LIMIT = 20

export const PROJECT_EVENT_ACTIVITY_OUTCOMES = [
  'recorded',
  'notified',
  'waiting',
  'processing',
  'needs-user',
  'done',
  'failed',
  'unknown'
] as const
export type ProjectEventActivityOutcome = (typeof PROJECT_EVENT_ACTIVITY_OUTCOMES)[number]

/** Public projection: never the delivery body or binding secret. */
export type ProjectEventActivityEntry = {
  id: number
  kind: ForgeItemKind | 'unknown'
  iid: number | null
  title: string
  occurredAt: number
  /** When the delivery finished; absent from older hosts, where occurredAt is the only time. */
  finishedAt?: number
  outcome: ProjectEventActivityOutcome
  errorCode: string | null
  errorSource?: ForgeInboxErrorSource
}

export type ProjectEventActivityView = {
  events: ProjectEventActivityEntry[]
  /** The latest delivery that ended (done/failed); pending, parked and needs-auth are not terminal. */
  lastProcessed: ProjectEventActivityEntry | null
}

export function clampProjectEventActivityLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return PROJECT_EVENT_ACTIVITY_DEFAULT_LIMIT
  }
  return Math.min(PROJECT_EVENT_ACTIVITY_MAX_LIMIT, Math.max(1, Math.trunc(value)))
}

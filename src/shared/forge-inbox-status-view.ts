import type { ForgeInboxActiveRunView } from './forge-inbox-types'

export type ForgeInboxPhase = 'new' | 'running' | 'stopped'

export type ForgeInboxListenerView = {
  enabled: boolean
  listening: boolean
  port: number | null
  error: string | null
}

export type ForgeInboxWorkView = {
  pending: number
  needsAuth: number
  nextAttemptAtMs: number | null
  draining: boolean
}

/** A host with no attached runtime capability answers only the unattached variant. */
export type ForgeInboxStatus =
  | { ownerHostId: null; available: false; phase: 'unattached' }
  | {
      ownerHostId: string
      available: boolean
      phase: ForgeInboxPhase
      running: boolean
      dormant: boolean
      listener: ForgeInboxListenerView
      work: ForgeInboxWorkView
      /** Absent from older hosts, which have no active-run summary to read. */
      activeRuns?: ForgeInboxActiveRunView[]
    }

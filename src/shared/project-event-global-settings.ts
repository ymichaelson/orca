import type { ProjectEventReceiverSettings } from './project-event-receiver-settings'
import type { ProjectEventDecisionSettings } from './project-event-decision-settings'

export type ProjectEventGlobalSettings = {
  /** Global webhook receiver for the project event Agent (§3.1). Optional for pre-feature
   *  profiles; the persistence merge hydrates the default. */
  projectEventReceiver?: ProjectEventReceiverSettings
  /** Jev or Laya for the project event Agent (§3.2). The key is stored encrypted. Optional for
   *  pre-feature profiles; the persistence merge hydrates the default. */
  projectEventDecision?: ProjectEventDecisionSettings
  /** Jev's key. Each provider keeps its own key so switching never forwards one to the other. */
  projectEventDecisionKey?: string
  /** Laya's optional key, stored encrypted like Jev's. */
  projectEventDecisionLayaKey?: string
}

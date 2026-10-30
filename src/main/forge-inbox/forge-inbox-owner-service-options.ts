import type { SecretStore } from '../../shared/secret-store'
import type { ProjectEventReceiverSettingsSource } from '../project-events/project-event-receiver-settings-source'
import type { MainHttpClient } from '../network/http-client'
import type { DispatchConfirmationReaderFactory } from './forge-inbox-dispatch-confirmation-reader'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeProjectEventAgentLaunchFactory } from './forge-inbox-project-event-agent-launch'
import type {
  ProjectEventDecisionInput,
  ProjectEventDecisionResult
} from '../../shared/project-event-decision'
import type { ForgeNotificationSink } from './forge-inbox-notification-processor'
import type { ProjectEventActionClaim } from './forge-inbox-project-event-action'
import type { ProjectEventHeadObservation } from './forge-inbox-project-event-observation'
import type { ForgeWebhookIngressOptions } from './forge-inbox-webhook-ingress'
import type { ProjectBindingContext } from './forge-inbox-project-binding-context'
import type { ProjectBindingProbe } from './forge-inbox-project-binding-reconcile'
import type { GlabExecOptions } from '../git/command-runner/glab-exec-file'

export type ForgeProjectEventContextObserver = (
  claim: ProjectEventActionClaim,
  signal?: AbortSignal
) => Promise<ProjectEventHeadObservation>

export type ForgeInboxOwnerServiceOptions = {
  dbPath: string
  http: Pick<MainHttpClient, 'fetch'>
  secretStore?: SecretStore
  hostId?: string
  now?: () => number
  ingress?: ForgeWebhookIngressOptions
  receiverSettings?: ProjectEventReceiverSettingsSource
  /** Gates the decision and action drains; a rejection counts as ready so the inbox never wedges. */
  networkReady?: Promise<void>
  /** Receive at-most-once attention notices; with none, the ledger's notification feed is never claimed. */
  notificationSinks?: readonly ForgeNotificationSink[]
  /** With none, a binding delivery stays pending: nothing is decided and nothing is dropped. */
  decideProjectEvent?: (
    input: ProjectEventDecisionInput,
    signal?: AbortSignal
  ) => Promise<ProjectEventDecisionResult>
  /** With none, a fetch_context action fails closed as context-unavailable. */
  observeProjectEventContext?: (ledger: ForgeInboxLedger) => ForgeProjectEventContextObserver
  /** With none, dispatch_agent fails closed as dispatch-unavailable. */
  launchProjectEventAgent?: ForgeProjectEventAgentLaunchFactory
  /** Queries the journal for dispatched runs a dead process left unverifiable; absent means never. */
  recoverProjectEventRuns?: (ledger: ForgeInboxLedger) => Promise<void>
  /** Reads GitLab to check what a dispatched agent reported; absent means its effects stay unconfirmed. */
  createProjectEventDispatchReader?: DispatchConfirmationReaderFactory
  /** Resolves the real path and host for a repository; a client path is never accepted. */
  resolveProjectBindingContext?: (repoId: string) => ProjectBindingContext
  /** Injected glab runner; without one the host binary is used. */
  projectBindingExec?: (
    args: string[],
    options?: GlabExecOptions
  ) => Promise<{ stdout: string; stderr: string }>
  /** With none, the host's own receiver is probed over loopback. */
  probeProjectEventBinding?: ProjectBindingProbe
}

import type { SecretStore } from '../../shared/secret-store'
import type { MainHttpClient } from '../network/http-client'
import type { ForgeAnalysisRunner } from './forge-inbox-coordinator'
import type { ForgeInboxDiscuss } from './forge-inbox-discuss'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeNotificationSink } from './forge-inbox-notification-processor'
import type { ForgeInboxPatchProducer } from './forge-inbox-patch-produce'
import type { ForgeWebhookIngressOptions } from './forge-inbox-webhook-ingress'

/** Built once the ledger is open: the runner and the launch policy both read items from it. */
export type ForgeAnalysisRunnerFactory = (ledger: ForgeInboxLedger) => ForgeAnalysisRunner

export type ForgeInboxOwnerServiceOptions = {
  dbPath: string
  http: Pick<MainHttpClient, 'fetch'>
  secretStore?: SecretStore
  hostId?: string
  now?: () => number
  ingress?: ForgeWebhookIngressOptions
  /** Gates only the worker's network use; a rejection counts as ready so the inbox never wedges. */
  networkReady?: Promise<void>
  /** Receive at-most-once attention notices; with none, the ledger's notification feed is never claimed. */
  notificationSinks?: readonly ForgeNotificationSink[]
  /** With none, queued analyses stay queued until a host that can run them opens this ledger. */
  analyse?: ForgeAnalysisRunnerFactory
  /** With none, Discuss is refused: a session this host cannot prove is never resumed elsewhere. */
  discuss?: (ledger: ForgeInboxLedger) => ForgeInboxDiscuss
  /** With none, patch proposals are refused: a turn this host cannot run is never faked. */
  proposePatch?: (ledger: ForgeInboxLedger) => ForgeInboxPatchProducer
}

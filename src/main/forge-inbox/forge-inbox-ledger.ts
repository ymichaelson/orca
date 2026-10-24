import { getSecretStore, type SecretStore } from '../../shared/secret-store'
import type Database from '../sqlite/sync-database'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { forgeCommitSignal, type ForgeCommitListener } from './forge-inbox-commit-signal'
import { getForgeConfig, updateForgeConfig } from './forge-inbox-config'
import {
  clearForgeCredential,
  readForgeSecret,
  setForgeCredential
} from './forge-inbox-credentials'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { bumpForgePolicyGeneration } from './forge-inbox-policy'
import { listForgeEvents } from './forge-inbox-events'
import { ingestForgeEvent } from './forge-inbox-ingest'
import { createForgeNotificationFeed } from './forge-inbox-notification-feed'
import { ingestForgeObservation, type ForgeObservationInput } from './forge-inbox-observation'
import {
  beginForgeReceipt,
  consumeForgeProposal,
  createForgeProposal,
  finishForgeReceipt,
  readForgeProposal,
  rejectForgeProposal,
  staleForgeProposal
} from './forge-inbox-proposals'
import {
  getForgeClientCursor,
  getForgeItemDetail,
  readForgeItem,
  listForgeChanges,
  listForgeItems,
  listForgeRuns,
  markForgeItemRead,
  readForgeChangeHead,
  setForgeClientCursor
} from './forge-inbox-queries'
import type { ForgeEventIngest, ForgeInstanceScope } from './forge-inbox-types'
import {
  admitForgeWebhookDelivery,
  FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
  getForgeWebhookQueueStatus,
  listForgeWebhookDeliveries,
  type ForgeWebhookAdmission,
  type ForgeWebhookQueueLimits
} from './forge-inbox-webhook-queue'
import {
  claimNextForgeWebhookDelivery,
  getForgeWebhookWorkSchedule,
  markForgeWebhookDeliveryDone,
  markForgeWebhookDeliveryFailed,
  markForgeWebhookDeliveryNeedsAuth,
  pruneFinishedForgeWebhookDeliveries,
  requeueForgeWebhookNeedsAuth
} from './forge-inbox-webhook-delivery-state'
import { updateForgeProjectPolicy } from './forge-inbox-project-policy-update'
import { claimForgePatchRequest, readForgePatchRequest } from './forge-inbox-patch-requests'
import { recoverInterruptedForgeWork } from './forge-inbox-interrupted-work'
import {
  checkForgePatchRequestFences,
  finishForgePatchRequest
} from './forge-inbox-patch-request-completion'
import { readForgeItemWatermark } from './forge-inbox-item-watermark'
import { readForgeProjectInvalidationGeneration } from './forge-inbox-project-invalidation'
import {
  bindForgeRunSession,
  claimNextQueuedForgeRun,
  readForgeRun,
  transitionForgeRun
} from './forge-inbox-runs'
import {
  cancelRevokedForgeRuns,
  claimNextRunnableForgeRun,
  forgeRunPolicyIsCurrent,
  supersedeStaleForgeRuns
} from './forge-inbox-run-scheduling'

/** Durable forge-inbox ledger. Callers pass hostId/instanceId on every read; nothing is global. */
export class ForgeInboxLedger {
  private readonly ctx: ForgeLedgerContext
  private readonly webhookLimits: ForgeWebhookQueueLimits
  readonly notifications: ReturnType<typeof createForgeNotificationFeed>

  private constructor(
    db: Database.Database,
    hostId: string,
    now: () => number,
    secretStore: () => SecretStore,
    webhookLimits: ForgeWebhookQueueLimits
  ) {
    this.webhookLimits = webhookLimits
    this.ctx = { db, hostId, now, secretStore }
    this.notifications = createForgeNotificationFeed(this.ctx)
  }

  /**
   * Throws (leaving the file untouched) for a newer schema or an unreadable database. Without a
   * hostId a new file mints and persists its own owner id; an existing file keeps the one it has.
   */
  static open(
    dbPath: string,
    options: {
      hostId?: string
      now?: () => number
      secretStore?: SecretStore
      webhookQueueLimits?: ForgeWebhookQueueLimits
    } = {}
  ): ForgeInboxLedger {
    const { db, hostId } = openForgeInboxDatabase(dbPath, options.hostId)
    const { secretStore } = options
    const ledger = new ForgeInboxLedger(
      db,
      hostId,
      options.now ?? Date.now,
      secretStore ? () => secretStore : getSecretStore,
      options.webhookQueueLimits ?? FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS
    )
    recoverInterruptedForgeWork(ledger.ctx)
    return ledger
  }

  get hostId(): string {
    return this.ctx.hostId
  }

  close(): void {
    forgeCommitSignal(this.ctx.db).close()
    this.ctx.db.close()
  }

  /** Metadata hint after each committed write; never inside a transaction and never a failure of it. */
  onCommitted(listener: ForgeCommitListener): () => void {
    return forgeCommitSignal(this.ctx.db).subscribe(listener)
  }

  readChangeHead(scope: ForgeInstanceScope) {
    return readForgeChangeHead(this.ctx, scope)
  }

  updateProjectPolicy(
    expectedRevision: number,
    input: Parameters<typeof updateForgeProjectPolicy>[2]
  ) {
    return updateForgeProjectPolicy(this.ctx, expectedRevision, input)
  }

  getConfig() {
    return getForgeConfig(this.ctx)
  }

  updateConfig(expectedRevision: number, config: unknown) {
    return updateForgeConfig(this.ctx, expectedRevision, config)
  }

  setCredential(input: Parameters<typeof setForgeCredential>[1]) {
    return setForgeCredential(this.ctx, input)
  }

  clearCredential(input: Parameters<typeof clearForgeCredential>[1]) {
    return clearForgeCredential(this.ctx, input)
  }

  /** Host-private plaintext access for the trusted broker; never expose over RPC. */
  readSecret(instanceId: string, kind: Parameters<typeof readForgeSecret>[2]) {
    return readForgeSecret(this.ctx, instanceId, kind)
  }

  ingestEvent(input: ForgeEventIngest) {
    return ingestForgeEvent(this.ctx, input)
  }

  /** The ledger's own clock, so workers never schedule against an unvalidated caller clock. */
  nowMs(): number {
    return this.ctx.now()
  }
  readProjectInvalidationGeneration(
    project: Parameters<typeof readForgeProjectInvalidationGeneration>[1]
  ) {
    return readForgeProjectInvalidationGeneration(this.ctx, project)
  }

  ingestObservation(
    input: ForgeObservationInput,
    expectedConfigRevision: number,
    expectedInvalidationGeneration: number
  ) {
    return ingestForgeObservation(
      this.ctx,
      input,
      expectedConfigRevision,
      expectedInvalidationGeneration
    )
  }
  admitWebhookDelivery(input: ForgeWebhookAdmission) {
    return admitForgeWebhookDelivery(this.ctx, this.webhookLimits, input)
  }

  getWebhookQueueStatus() {
    return getForgeWebhookQueueStatus(this.ctx, this.webhookLimits)
  }

  /** Host-private raw bodies for the trusted worker; never expose over RPC. */
  claimNextWebhookDelivery(nowMs: number) {
    return claimNextForgeWebhookDelivery(this.ctx, nowMs)
  }

  getWebhookWorkSchedule() {
    return getForgeWebhookWorkSchedule(this.ctx)
  }

  markWebhookDeliveryDone(id: number) {
    return markForgeWebhookDeliveryDone(this.ctx, id)
  }

  markWebhookDeliveryFailed(
    id: number,
    failure: Parameters<typeof markForgeWebhookDeliveryFailed>[2]
  ) {
    return markForgeWebhookDeliveryFailed(this.ctx, id, failure)
  }

  markWebhookDeliveryNeedsAuth(id: number) {
    return markForgeWebhookDeliveryNeedsAuth(this.ctx, id)
  }

  requeueNeedsAuthWebhookDeliveries(instanceId: string) {
    return requeueForgeWebhookNeedsAuth(this.ctx, instanceId)
  }

  pruneFinishedWebhookDeliveries(query: Parameters<typeof pruneFinishedForgeWebhookDeliveries>[1]) {
    return pruneFinishedForgeWebhookDeliveries(this.ctx, query)
  }

  readItemWatermark(key: Parameters<typeof readForgeItemWatermark>[1]) {
    return readForgeItemWatermark(this.ctx, key)
  }

  listWebhookDeliveries(query: Parameters<typeof listForgeWebhookDeliveries>[1]) {
    return listForgeWebhookDeliveries(this.ctx, query)
  }

  claimNextQueuedRun(scope: ForgeInstanceScope) {
    return claimNextQueuedForgeRun(this.ctx, scope)
  }

  claimNextRunnableRun(
    scope: ForgeInstanceScope,
    limits: Parameters<typeof claimNextRunnableForgeRun>[2]
  ) {
    return claimNextRunnableForgeRun(this.ctx, scope, limits)
  }

  supersedeStaleRuns(scope: ForgeInstanceScope) {
    return supersedeStaleForgeRuns(this.ctx, scope)
  }

  cancelRevokedRuns(scope: ForgeInstanceScope) {
    return cancelRevokedForgeRuns(this.ctx, scope)
  }

  bindRunSession(runId: number, sessionId: string) {
    return bindForgeRunSession(this.ctx, runId, sessionId)
  }

  runPolicyIsCurrent(runId: number) {
    return forgeRunPolicyIsCurrent(this.ctx, runId)
  }

  transitionRun(runId: number, change: Parameters<typeof transitionForgeRun>[2]) {
    return transitionForgeRun(this.ctx, runId, change)
  }

  getRun(runId: number) {
    return readForgeRun(this.ctx, runId)
  }

  claimPatchRequest(input: Parameters<typeof claimForgePatchRequest>[1]) {
    return claimForgePatchRequest(this.ctx, input)
  }

  getPatchRequest(scope: ForgeInstanceScope, requestId: number, callerKey: string) {
    return readForgePatchRequest(this.ctx, requestId, callerKey, scope)
  }

  finishPatchRequest(input: Parameters<typeof finishForgePatchRequest>[1]) {
    return finishForgePatchRequest(this.ctx, input)
  }

  checkPatchRequestFences(request: Parameters<typeof checkForgePatchRequestFences>[1]) {
    return checkForgePatchRequestFences(this.ctx, request)
  }

  createProposal(input: Parameters<typeof createForgeProposal>[1]) {
    return createForgeProposal(this.ctx, input)
  }

  getProposal(id: number) {
    return readForgeProposal(this.ctx, id)
  }

  consumeProposal(id: number, expected: Parameters<typeof consumeForgeProposal>[2]) {
    return consumeForgeProposal(this.ctx, id, expected)
  }

  bumpPolicyGeneration(project: Parameters<typeof bumpForgePolicyGeneration>[1]) {
    return bumpForgePolicyGeneration(this.ctx, project)
  }

  rejectProposal(id: number) {
    return rejectForgeProposal(this.ctx, id)
  }

  staleProposal(id: number, expected: Parameters<typeof staleForgeProposal>[2]) {
    return staleForgeProposal(this.ctx, id, expected)
  }

  beginReceipt(input: Parameters<typeof beginForgeReceipt>[1]) {
    return beginForgeReceipt(this.ctx, input)
  }

  finishReceipt(id: number, outcome: Parameters<typeof finishForgeReceipt>[2]) {
    return finishForgeReceipt(this.ctx, id, outcome)
  }

  listItems(query: Parameters<typeof listForgeItems>[1]) {
    return listForgeItems(this.ctx, query)
  }

  getItem(scope: ForgeInstanceScope, itemId: number) {
    return readForgeItem(this.ctx, scope, itemId)
  }

  getItemDetail(scope: ForgeInstanceScope, itemId: number, clientId: string) {
    return getForgeItemDetail(this.ctx, scope, itemId, clientId)
  }

  listRuns(scope: ForgeInstanceScope, query: Parameters<typeof listForgeRuns>[2]) {
    return listForgeRuns(this.ctx, scope, query)
  }

  listEvents(scope: ForgeInstanceScope, query: Parameters<typeof listForgeEvents>[2]) {
    return listForgeEvents(this.ctx, scope, query)
  }

  listChanges(scope: ForgeInstanceScope, query: Parameters<typeof listForgeChanges>[2]) {
    return listForgeChanges(this.ctx, scope, query)
  }

  markRead(scope: ForgeInstanceScope, input: Parameters<typeof markForgeItemRead>[2]) {
    return markForgeItemRead(this.ctx, scope, input)
  }

  setClientCursor(input: Parameters<typeof setForgeClientCursor>[1]) {
    setForgeClientCursor(this.ctx, input)
  }

  getClientCursor(input: Parameters<typeof getForgeClientCursor>[1]) {
    return getForgeClientCursor(this.ctx, input)
  }
}

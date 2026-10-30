import { getSecretStore, type SecretStore } from '../../shared/secret-store'
import type Database from '../sqlite/sync-database'
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
import { isForgeDispatchedAgent } from './forge-inbox-dispatched-agent-ownership'
import { archiveForgeItem, unarchiveForgeItem } from './forge-inbox-item-archive'
import { ingestForgeEvent } from './forge-inbox-ingest'
import { createForgeNotificationFeed } from './forge-inbox-notification-feed'
import { ingestForgeObservation, type ForgeObservationInput } from './forge-inbox-observation'
import { ForgeProposalLedger } from './forge-inbox-ledger-proposals'
import {
  getForgeItemDetail,
  readForgeItem,
  listForgeItemProjects,
  listForgeItems,
  listForgeRuns,
  markForgeItemRead
} from './forge-inbox-queries'
import {
  getForgeClientCursor,
  listForgeChanges,
  readForgeChangeHead,
  setForgeClientCursor
} from './forge-inbox-change-cursors'
import type { ForgeEventIngest, ForgeInstanceScope } from './forge-inbox-types'
import {
  FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
  type ForgeWebhookQueueLimits
} from './forge-inbox-webhook-queue'
import {
  createForgeWebhookLedgerMethods,
  type ForgeWebhookLedgerMethods
} from './forge-inbox-ledger-webhook-methods'
import { updateForgeProjectPolicy } from './forge-inbox-project-policy-update'
import {
  getProjectEventPolicy,
  listProjectEventPolicies,
  updateProjectEventPolicy
} from './forge-inbox-project-event-policy'
import { readProjectEventActivity } from './forge-inbox-project-event-activity'
import {
  ensureProjectBinding,
  removeProjectBinding as removeProjectBindingRemote
} from './forge-inbox-project-binding-reconcile'
import { getProjectBinding as readProjectBinding } from './forge-inbox-project-binding'
import { getProjectEventRepoLink as readProjectEventRepoLink } from './forge-inbox-project-event-link'
import { resumeProjectEventDeliveriesForRepo } from './forge-inbox-project-event-receive'
import { rotateProjectBindingSecret } from './forge-inbox-project-binding-rotation'
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

// SAFETY: composition installs these methods per instance; the interface only types them.
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging typescript/consistent-type-definitions
export interface ForgeInboxLedger extends ForgeWebhookLedgerMethods {}

/** Durable forge-inbox ledger. Callers pass hostId/instanceId on every read; nothing is global. */
export class ForgeInboxLedger extends ForgeProposalLedger {
  readonly notifications: ReturnType<typeof createForgeNotificationFeed>
  readonly dbPath: string
  private closed = false

  private constructor(
    db: Database.Database,
    hostId: string,
    now: () => number,
    secretStore: () => SecretStore,
    webhookLimits: ForgeWebhookQueueLimits,
    dbPath: string
  ) {
    super({ db, hostId, now, secretStore })
    this.dbPath = dbPath
    this.notifications = createForgeNotificationFeed(this.ctx)
    Object.assign(this, createForgeWebhookLedgerMethods(this.ctx, webhookLimits))
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
      options.webhookQueueLimits ?? FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
      dbPath
    )
    recoverInterruptedForgeWork(ledger.ctx)
    return ledger
  }

  get hostId(): string {
    return this.ctx.hostId
  }

  close(): void {
    this.closed = true
    forgeCommitSignal(this.ctx.db).close()
    this.ctx.db.close()
  }

  /** Tells a detached subscriber whether its failures mean "gone" or "try again". */
  isClosed(): boolean {
    return this.closed
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

  getProjectEventPolicy(repoId: string) {
    return getProjectEventPolicy(this.ctx, repoId)
  }

  listProjectEventPolicies() {
    return listProjectEventPolicies(this.ctx)
  }

  getProjectEventActivity(repoId: string, limit?: number) {
    return readProjectEventActivity(this.ctx, {
      repoId,
      ...(limit === undefined ? {} : { limit })
    })
  }

  updateProjectEventPolicy(repoId: string, expectedGeneration: number, patch: unknown) {
    const result = updateProjectEventPolicy(this.ctx, { repoId, expectedGeneration, patch })
    if (result.ok && result.policy.enabled) {
      resumeProjectEventDeliveriesForRepo(this.ctx, repoId)
    }
    return result
  }

  ensureProjectBinding(input: Parameters<typeof ensureProjectBinding>[1]) {
    return ensureProjectBinding(this.ctx, input)
  }

  getProjectBinding(bindingId: string) {
    return readProjectBinding(this.ctx, bindingId)
  }

  getProjectEventRepoLink(repoId: string) {
    return readProjectEventRepoLink(this.ctx, repoId)
  }

  removeProjectBinding(input: Parameters<typeof removeProjectBindingRemote>[1]) {
    return removeProjectBindingRemote(this.ctx, input)
  }

  rotateProjectBindingSecret(input: Parameters<typeof rotateProjectBindingSecret>[1]) {
    return rotateProjectBindingSecret(this.ctx, input)
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
  /** Host-private ledger context for the trusted receiver; never expose over RPC. */
  ledgerContext() {
    return this.ctx
  }

  readItemWatermark(key: Parameters<typeof readForgeItemWatermark>[1]) {
    return readForgeItemWatermark(this.ctx, key)
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

  bumpPolicyGeneration(project: Parameters<typeof bumpForgePolicyGeneration>[1]) {
    return bumpForgePolicyGeneration(this.ctx, project)
  }

  listItems(query: Parameters<typeof listForgeItems>[1]) {
    return listForgeItems(this.ctx, query)
  }

  listItemProjects() {
    return listForgeItemProjects(this.ctx)
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

  isDispatchedAgent(identity: Parameters<typeof isForgeDispatchedAgent>[1]) {
    return isForgeDispatchedAgent(this.ctx, identity)
  }

  archiveItem(scope: ForgeInstanceScope, input: Parameters<typeof archiveForgeItem>[2]) {
    return archiveForgeItem(this.ctx, scope, input)
  }

  unarchiveItem(scope: ForgeInstanceScope, input: Parameters<typeof unarchiveForgeItem>[2]) {
    return unarchiveForgeItem(this.ctx, scope, input)
  }

  setClientCursor(input: Parameters<typeof setForgeClientCursor>[1]) {
    setForgeClientCursor(this.ctx, input)
  }

  getClientCursor(input: Parameters<typeof getForgeClientCursor>[1]) {
    return getForgeClientCursor(this.ctx, input)
  }
}

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SecretStore } from '../../shared/secret-store'
import { ingestForgeEventInTransaction, queueForgeItemRun } from './forge-inbox-ingest'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { CANCEL_SESSION } from './forge-inbox-project-event-run-cancel-fake-host'

import {
  bindForgeRunDispatchTurn,
  bindForgeRunSession,
  transitionForgeRun
} from './forge-inbox-runs'

export {
  CANCEL_SESSION,
  createFakeCancelHost,
  createFakeCancelRuntime
} from './forge-inbox-project-event-run-cancel-fake-host'

export const CANCEL_REPO_ID = 'repo-1'
export const OTHER_REPO_ID = 'repo-2'
export const CANCEL_MESSAGE = '1700000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export const OPERATION_ID_PATTERN = /^\d{13}-[0-9a-f]{32}$/

export type DispatchLedgerFixture = {
  readonly ledger: ForgeInboxLedger
  reopen(): ForgeInboxLedger
  dispose(): void
}

/** A real SQLite ledger with two repos, each linked to its own binding and configured to dispatch. */
export function openDispatchLedger(): DispatchLedgerFixture {
  const root = mkdtempSync(join(tmpdir(), 'forge-run-cancel-'))
  const path = join(root, 'forge-inbox.sqlite')
  const open = (): ForgeInboxLedger =>
    ForgeInboxLedger.open(path, {
      hostId: 'host-1',
      now: () => Date.now(),
      secretStore: fakeStore()
    })
  let ledger = open()
  for (const [repoId, gitlabPath, gitlabProjectId] of [
    [CANCEL_REPO_ID, 'group/demo', 3],
    [OTHER_REPO_ID, 'group/other', 4]
  ] as const) {
    const bindingId = randomUUID()
    upsertProjectBinding(ledger.ledgerContext(), {
      bindingId,
      projectPath: `/${repoId}`,
      gitlabHost: 'gitlab.test',
      gitlabPath,
      gitlabProjectId,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
    })
    linkProjectEventBinding(ledger.ledgerContext(), { repoId, bindingId })
    updatePolicy(ledger, repoId, { enabled: true, agentId: 'claude', model: 'claude-sonnet-5-5' })
  }
  return {
    get ledger() {
      return ledger
    },
    reopen() {
      ledger.close()
      ledger = open()
      return ledger
    },
    dispose() {
      ledger.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** The production policy write; throws if the fixture's own change was rejected. */
export function updatePolicy(
  ledger: ForgeInboxLedger,
  repoId: string,
  patch: Record<string, unknown>
): number {
  const result = ledger.updateProjectEventPolicy(
    repoId,
    ledger.getProjectEventPolicy(repoId)?.generation ?? 0,
    patch
  )
  if (!result.ok) {
    throw new Error(`fixture policy rejected: ${result.reason}`)
  }
  return result.generation
}

export type SeedRun = {
  iid: number
  gitlabPath?: string
  instanceId?: string
  title?: string
  reason?: string
  state?: 'queued' | 'running' | 'unverifiable' | 'succeeded'
  sessionId?: string | null
  messageId?: string | null
}

/** A run queued by the real pipeline, then moved to the requested state the way the launcher would. */
export function seedRun(ledger: ForgeInboxLedger, options: SeedRun): number {
  const ctx = ledger.ledgerContext()
  const ingested = ingestForgeEventInTransaction(ctx, {
    hostId: ctx.hostId,
    instanceId: options.instanceId ?? 'gitlab:gitlab.test',
    projectId: options.gitlabPath ?? 'group/demo',
    kind: 'merge_request',
    iid: options.iid,
    dedupeKey: `d-${randomUUID()}`,
    eventKind: 'Merge Request Hook',
    versionToken: `v-${randomUUID()}`,
    sourceOrder: 1,
    payload: {},
    ...(options.title === undefined ? {} : { title: options.title })
  })
  if (ingested.duplicate) {
    throw new Error('fixture expected a first delivery')
  }
  const runId = queueForgeItemRun(ctx, ingested.itemId, options.reason ?? 'project-event-dispatch')
  if (runId === null) {
    throw new Error('fixture could not queue the run')
  }
  const state = options.state ?? 'running'
  if (state === 'queued') {
    return runId
  }
  if (!transitionForgeRun(ctx, runId, { to: 'running' }).ok) {
    throw new Error('fixture could not start the run')
  }
  const sessionId = options.sessionId === undefined ? CANCEL_SESSION : options.sessionId
  if (sessionId !== null && !bindForgeRunSession(ctx, runId, sessionId)) {
    throw new Error('fixture could not bind the session')
  }
  const messageId = options.messageId === undefined ? CANCEL_MESSAGE : options.messageId
  if (messageId !== null && !bindForgeRunDispatchTurn(ctx, runId, messageId)) {
    throw new Error('fixture could not bind the turn')
  }
  if (state === 'unverifiable') {
    transitionForgeRun(ctx, runId, { to: 'unverifiable', error: 'unknown-outcome' })
  } else if (state === 'succeeded') {
    transitionForgeRun(ctx, runId, { to: 'succeeded' })
  }
  return runId
}

export function runRow(ledger: ForgeInboxLedger, runId: number) {
  const row = ledger
    .ledgerContext()
    .db.prepare(
      `SELECT state, generation, error, policy_generation, session_id, dispatch_client_message_id,
         cancel_requested_at, cancel_operation_id, cancel_policy_generation, cancel_delivery,
         cancel_fence FROM runs WHERE id = ?`
    )
    .get(runId)
  if (!row) {
    throw new Error(`run ${runId} is missing`)
  }
  return row
}

/** What a crash leaves behind: a dispatched run whose stop was committed with a policy change, never delivered. */
export function seedCommittedStop(
  dbPath: string,
  secretStore: SecretStore,
  options: { repoId?: string; sessionId?: string } = {}
): { runId: number; operationId: string } {
  const repoId = options.repoId ?? 'repo-1'
  const ledger = ForgeInboxLedger.open(dbPath, { secretStore })
  try {
    updatePolicy(ledger, repoId, { agentId: 'claude', model: 'claude-sonnet-5-5' })
    const runId = seedRun(ledger, {
      iid: 7,
      instanceId: 'gitlab:gitlab.example.com',
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId })
    })
    updatePolicy(ledger, repoId, { rules: 'New rules.' })
    const operationId = runRow(ledger, runId).cancel_operation_id
    if (typeof operationId !== 'string') {
      throw new Error('fixture expected a committed stop')
    }
    return { runId, operationId }
  } finally {
    ledger.close()
  }
}

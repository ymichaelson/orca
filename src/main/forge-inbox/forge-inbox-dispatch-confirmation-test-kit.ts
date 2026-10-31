import { randomUUID } from 'node:crypto'
import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  createDispatchConfirmation,
  recordDispatchCapture
} from './forge-inbox-dispatch-confirmation'
import type { DispatchReportCapture } from './forge-inbox-dispatch-report'
import { ingestForgeEventInTransaction, queueForgeItemRun } from './forge-inbox-ingest'
import { transitionForgeRun } from './forge-inbox-runs'

export const CONFIRMATION_TEST_SHA = 'a'.repeat(40)

export type SeededDispatchRun = { runId: number; itemId: number; marker: string }

/** One dispatch run with its confirmation row, captured report and (unless `running`) its settled state. */
export function seedDispatchRun(
  ctx: ForgeLedgerContext,
  options: {
    binding: { bindingId: string; gitlabHost: string; gitlabProjectId: number }
    report: DispatchReportCapture | null
    itemKind?: 'merge_request' | 'issue' | 'project' | 'pipeline'
    itemIid?: number
    /** GitLab's state for the stored item, such as `opened`. */
    itemState?: string
    /** Distinguishes the stored item from the one the confirmation names, so rows never collide. */
    storedIid: number
    expectedSha?: string | null
    runState?: 'succeeded' | 'failed' | 'cancelled' | 'running'
  }
): SeededDispatchRun {
  const itemKind = options.itemKind ?? 'merge_request'
  const ingested = ingestForgeEventInTransaction(ctx, {
    hostId: ctx.hostId,
    instanceId: `gitlab:${options.binding.gitlabHost}`,
    projectId: 'group/demo',
    kind: itemKind,
    iid: options.storedIid,
    dedupeKey: `d-${randomUUID()}`,
    eventKind: 'Merge Request Hook',
    versionToken: `v-${randomUUID()}`,
    sourceOrder: 1,
    payload: {},
    ...(options.itemState === undefined ? {} : { itemState: options.itemState })
  })
  if (ingested.duplicate) {
    throw new Error('fixture expected a first delivery')
  }
  const runId = queueForgeItemRun(ctx, ingested.itemId, 'project-event-dispatch')
  if (runId === null || !transitionForgeRun(ctx, runId, { to: 'running' }).ok) {
    throw new Error('fixture could not start the run')
  }
  const marker = createDispatchConfirmation(ctx, {
    runId,
    bindingId: options.binding.bindingId,
    gitlabHost: options.binding.gitlabHost,
    gitlabProjectId: options.binding.gitlabProjectId,
    itemKind,
    itemIid: options.itemIid ?? 7,
    expectedSha: options.expectedSha === undefined ? CONFIRMATION_TEST_SHA : options.expectedSha
  })
  if (options.report !== null) {
    recordDispatchCapture(ctx, runId, {
      sessionId: 'session-1',
      clientMessageId: 'message-1',
      turnId: 'turn-1',
      report: options.report
    })
  }
  const settled = options.runState ?? 'succeeded'
  if (settled !== 'running') {
    const result = transitionForgeRun(ctx, runId, {
      to: settled,
      ...(settled === 'succeeded' ? {} : { error: settled })
    })
    if (!result.ok) {
      throw new Error('fixture could not settle the run')
    }
  }
  return { runId, itemId: ingested.itemId, marker }
}

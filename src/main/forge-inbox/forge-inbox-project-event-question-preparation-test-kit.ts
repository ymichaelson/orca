import type { AgentSessionTurnCompletionEvent } from '../../shared/agent-session-wire'
import type { AgentJournalTurnOutcome } from '../../shared/agent-turn-outcome'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { FORGE_ITEM_KINDS } from '../../shared/forge-inbox-types'
import type { ForgeLedgerContext } from './forge-inbox-context'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ProjectEventActionClaim } from './forge-inbox-project-event-action-types'
import {
  drainProjectEventActions,
  type ProjectEventActionDeps,
  type ProjectEventActionDrain
} from './forge-inbox-project-event-action-drain'
import {
  createForgeProjectEventAgentLaunch,
  type ProjectEventAgentLaunch,
  type ProjectEventAgentLaunchRuntime
} from './forge-inbox-project-event-agent-launch'
import {
  emptyProbe,
  launchPorts,
  WORKSPACE_ID,
  type Probe
} from './forge-inbox-project-event-agent-launch-test-kit'
import type { ProjectEventHeadObservation } from './forge-inbox-project-event-observation'
import {
  createForgeProjectEventRunWatch,
  type ProjectEventRunWatch
} from './forge-inbox-project-event-run-watch'
import type { ForgeProtectedTurnProof } from './forge-inbox-protected-turn-proof'
import { rowNumber } from './forge-inbox-rows'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

export const PREPARED_QUESTION = 'Should we release A or B?'

export function questionProofText(question: string): string {
  return `\`\`\`orca-question\n${JSON.stringify({ v: 1, kind: 'question', question })}\n\`\`\``
}

/** The authenticated head a provisional webhook event needs before dispatch may pay for it. */
export function observeItemHead(
  ctx: ForgeLedgerContext
): (claim: ProjectEventActionClaim) => Promise<ProjectEventHeadObservation> {
  return async (claim) => {
    const linked = ctx.db
      .prepare('SELECT item_id FROM project_event_decisions WHERE id = ? AND host_id = ?')
      .get(claim.decisionId, ctx.hostId)
    const itemId = claim.itemId ?? (linked ? rowNumber(linked, 'item_id') : null)
    if (itemId === null) {
      throw new Error('expected the claim to be linked to its item')
    }
    const item = ctx.db
      .prepare(
        `SELECT kind, iid, title, state, current_revision FROM items
         WHERE id = ? AND host_id = ?`
      )
      .get(itemId, ctx.hostId)
    if (!item) {
      throw new Error(`expected item ${itemId}`)
    }
    const kind = FORGE_ITEM_KINDS.find((candidate) => candidate === item.kind)
    if (kind === undefined) {
      throw new Error(`unexpected item kind ${String(item.kind)}`)
    }
    const revision = rowNumber(item, 'current_revision') + 1
    ctx.db
      .prepare(
        `INSERT INTO item_revisions (item_id, revision, version_token, source_order, created_at)
         VALUES (?, ?, 'sha256:observed', ?, ?)`
      )
      .run(itemId, revision, revision, ctx.now())
    ctx.db
      .prepare('UPDATE items SET current_revision = ?, head_order = ?, updated_at = ? WHERE id = ?')
      .run(revision, revision, ctx.now(), itemId)
    return {
      ok: true,
      itemId,
      revision,
      versionToken: 'sha256:observed',
      complete: true,
      newRevision: true,
      kind,
      iid: rowNumber(item, 'iid'),
      sha: null,
      title: typeof item.title === 'string' ? item.title : null,
      state: typeof item.state === 'string' ? item.state : null
    }
  }
}

export type HarnessOptions = {
  question?: string
  /** null makes every proof read unprovable, the state a turn that has not finished leaves. */
  proofText?: string | null
  runtime?: Partial<ProjectEventAgentLaunchRuntime>
  refusal?: { code: string; message: string }
  messageId?: string | null
  deliverError?: Error
  retryDelayMs?: number
}

export type QuestionPreparationHarness = {
  options: HarnessOptions
  probe: Probe
  launchAgent: ProjectEventAgentLaunch
  watch: ProjectEventRunWatch
  proofReads: { sessionId: string; clientMessageId: string }[]
  setProofText(text: string | null): void
  /** Refuses every launch from here on, the way a host without structured chat answers. */
  setRefusal(refusal: { code: string; message: string } | null): void
  /** The production drain, through a real launcher and a real run watch. */
  drain(overrides?: Partial<ProjectEventActionDeps>): Promise<ProjectEventActionDrain>
  /** Emits the session turn completion that production run watch reads the proof on. */
  complete(outcome?: AgentJournalTurnOutcome): Promise<void>
  sessionId(): string | null
  clientMessageId(): string | null
  runId(): number
  questionId(): number | null
  dispose(): void
}

export function openQuestionPreparationHarness(
  ledger: ForgeInboxLedger,
  options: HarnessOptions = {}
): QuestionPreparationHarness {
  const ctx = ledger.ledgerContext()
  const probe = emptyProbe()
  const proofReads: { sessionId: string; clientMessageId: string }[] = []
  let proofText: string | null =
    options.proofText === undefined
      ? questionProofText(options.question ?? PREPARED_QUESTION)
      : options.proofText
  let emit: (event: AgentSessionTurnCompletionEvent) => void = () => {}
  const watch = createForgeProjectEventRunWatch({
    ledger,
    readTurnProof: async (sessionId, clientMessageId) => {
      proofReads.push({ sessionId, clientMessageId })
      return proofText === null ? null : proof(sessionId, clientMessageId, proofText)
    },
    subscribeTurnCompletions: (subscriber) => {
      emit = subscriber.emit
      return () => {}
    },
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs })
  })
  // The ports read this object at launch time, so a test can refuse a later turn only.
  const ports = launchPorts(probe, options)
  ports.runWatch = watch
  const launchAgent = createForgeProjectEventAgentLaunch(ledger, ports)

  const lastRunId = (): number => {
    const row = ctx.db.prepare('SELECT MAX(id) AS id FROM runs').get()
    return row && typeof row.id === 'number' ? rowNumber(row, 'id') : 0
  }
  const sessionId = (): string | null =>
    probe.created.at(-1)?.envelope.sessionId ?? probe.delivered.at(-1)?.sessionId ?? null
  const clientMessageId = (): string | null => probe.delivered.at(-1)?.clientMessageId ?? null

  return {
    options,
    probe,
    launchAgent,
    watch,
    proofReads,
    setProofText(text) {
      proofText = text
    },
    setRefusal(refusal) {
      if (refusal === null) {
        delete options.refusal
        return
      }
      options.refusal = refusal
    },
    drain(overrides = {}) {
      return drainProjectEventActions(ctx, {
        limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
        observeContext: observeItemHead(ctx),
        // The factory contract builds on the ledger, not on the drain's context.
        launchAgentFactory: () => launchAgent,
        launchAgentLedger: ledger,
        ...overrides
      })
    },
    async complete(outcome = 'success') {
      const session = sessionId()
      if (session === null) {
        return
      }
      emit({
        type: 'completion',
        completion: {
          scope: {
            executionHostId: LOCAL_EXECUTION_HOST_ID,
            wslDistro: null,
            workspaceId: WORKSPACE_ID,
            workspaceKind: 'git-worktree'
          },
          sessionId: session,
          turnId: 'turn-1',
          outcome,
          completedAt: 1
        }
      })
      await flushPromiseChain()
    },
    sessionId,
    clientMessageId,
    runId: lastRunId,
    questionId() {
      const row = ctx.db.prepare('SELECT MAX(id) AS id FROM project_event_questions').get()
      return row && typeof row.id === 'number' ? rowNumber(row, 'id') : null
    },
    dispose() {
      watch.dispose()
    }
  }
}

function proof(
  _sessionId: string,
  _clientMessageId: string,
  text: string
): ForgeProtectedTurnProof {
  return {
    turnId: 'turn-1',
    terminal: true,
    outcome: 'success',
    text
  }
}

/** A bare run watch over one proof reader, the way production wires its turn lookups. */
export function openProofFeed(
  ledger: ForgeInboxLedger,
  readTurnProof: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<ForgeProtectedTurnProof | null>,
  retryDelayMs: number
): {
  watch: ProjectEventRunWatch
  complete(sessionId: string, outcome: AgentJournalTurnOutcome): Promise<void>
} {
  let emit: (event: AgentSessionTurnCompletionEvent) => void = () => {}
  const watch = createForgeProjectEventRunWatch({
    ledger,
    readTurnProof,
    subscribeTurnCompletions: (subscriber) => {
      emit = subscriber.emit
      return () => {}
    },
    retryDelayMs
  })
  return {
    watch,
    async complete(sessionId, outcome) {
      emit({
        type: 'completion',
        completion: {
          scope: {
            executionHostId: LOCAL_EXECUTION_HOST_ID,
            wslDistro: null,
            workspaceId: WORKSPACE_ID,
            workspaceKind: 'git-worktree'
          },
          sessionId,
          turnId: 'turn-1',
          outcome,
          completedAt: 1
        }
      })
      await flushPromiseChain()
    }
  }
}

export async function flushPromiseChain(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve()
  }
}

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { answerProjectEventQuestion } from './forge-inbox-project-event-question-answer'
import {
  openQuestionPreparationHarness,
  PREPARED_QUESTION
} from './forge-inbox-project-event-question-preparation-test-kit'
import {
  projectEventQuestionBody,
  projectEventQuestionDecision,
  seedProjectEventQuestionPolicy
} from './forge-inbox-project-event-question-test-kit'
import { attachForgeOpenQuestionWatch } from './forge-inbox-owner-open-question-watch'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

async function waitForState(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('open question activity', () => {
  let root: string
  let ledger: ForgeInboxLedger
  let ctx: ForgeLedgerContext
  let bindingId: string
  let clock: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-open-question-'))
    clock = 1000
    ledger = ForgeInboxLedger.open(join(root, 'forge-inbox.sqlite'), {
      hostId: 'host-1',
      now: () => ++clock,
      secretStore: fakeStore()
    })
    ctx = ledger.ledgerContext()
    bindingId = seedProjectEventQuestionPolicy(ctx)
  })

  afterEach(() => {
    ledger.close()
    rmSync(root, { recursive: true, force: true })
  })

  /** A question a background preparation asked, which no run a client watches can announce. */
  async function askPreparedQuestion(): Promise<{ itemId: number; questionId: number }> {
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Merge Request Hook',
      dedupeKey: `delivery-${randomUUID()}`,
      correlation: { eventUuid: null, configUuid: null },
      body: projectEventQuestionBody()
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }
    const decision = claimProjectEventDecision(ctx)
    if (
      !decision ||
      !decideProjectEventDelivery(
        ctx,
        admitted.deliveryId,
        projectEventQuestionDecision('ask_user'),
        decision
      ).ok
    ) {
      throw new Error('fixture could not record the ask_user decision')
    }
    const harness = openQuestionPreparationHarness(ledger)
    try {
      expect(await harness.drain()).toMatchObject({ executed: 1, failed: 0 })
      await harness.complete()
      await waitForState(
        () =>
          ctx.db.prepare(`SELECT 1 FROM project_event_questions WHERE status = 'open'`).get() !==
          undefined,
        'the prepared question'
      )
    } finally {
      harness.dispose()
    }
    const question = ctx.db
      .prepare(`SELECT id, item_id FROM project_event_questions WHERE status = 'open'`)
      .get()
    if (!question) {
      throw new Error('expected an open question')
    }
    return { itemId: Number(question.item_id), questionId: Number(question.id) }
  }

  /** A reader who marked the item read before the question was asked; asking it must make it unread. */
  function listedUnread(itemId: number): boolean {
    const row = ctx.db
      .prepare(
        `SELECT i.activity_seq,
          COALESCE((SELECT read_seq FROM item_reads WHERE client_id = 'reader-1' AND item_id = i.id), 0)
            AS read_seq
         FROM items i WHERE i.id = ?`
      )
      .get(itemId)
    return Number(row?.read_seq ?? 0) < Number(row?.activity_seq ?? 0)
  }

  it('makes the item unread and announces it when a question is asked and when it is answered', async () => {
    const { itemId, questionId } = await askPreparedQuestion()

    const asked = ctx.db
      .prepare(
        `SELECT seq FROM changes WHERE item_id = ? AND entity = 'question' AND change = 'opened'`
      )
      .get(itemId)
    expect(asked?.seq).toBe(Number(ctx.db.prepare('SELECT MAX(seq) AS s FROM changes').get()?.s))
    expect(listedUnread(itemId)).toBe(true)

    expect(
      answerProjectEventQuestion(ctx, {
        ownerHostId: ctx.hostId,
        questionId,
        answer: 'Use option 2'
      }).ok
    ).toBe(true)
    expect(
      ctx.db
        .prepare(
          `SELECT change FROM changes WHERE item_id = ? AND entity = 'question' ORDER BY seq`
        )
        .all(itemId)
        .map((row) => row.change)
    ).toEqual(['opened', 'answered'])
    expect(
      ctx.db.prepare(`SELECT activity_seq FROM items WHERE id = ?`).get(itemId)?.activity_seq
    ).toBe(Number(ctx.db.prepare('SELECT MAX(seq) AS s FROM changes').get()?.s))
  })

  it('holds the machine awake only while a question waits for a person', async () => {
    let held = 0
    const watch = attachForgeOpenQuestionWatch(
      ledger,
      {
        acquireExternalHold: () => {
          held += 1
          return {
            release: () => {
              held -= 1
            }
          }
        }
      },
      () => {}
    )
    expect(held).toBe(0)

    const { questionId } = await askPreparedQuestion()
    watch?.refresh()
    expect(held).toBe(1)

    answerProjectEventQuestion(ctx, { ownerHostId: ctx.hostId, questionId, answer: 'Keep it' })
    watch?.refresh()
    expect(held).toBe(0)
    watch?.stop()
    expect(held).toBe(0)
  })

  it('releases a held question when the owner stops', async () => {
    let held = 0
    const watch = attachForgeOpenQuestionWatch(
      ledger,
      {
        acquireExternalHold: () => {
          held += 1
          return {
            release: () => {
              held -= 1
            }
          }
        }
      },
      () => {}
    )
    await askPreparedQuestion()
    watch?.refresh()
    expect(held).toBe(1)

    watch?.stop()
    expect(held).toBe(0)
  })

  it('never watches without a hold port', () => {
    expect(attachForgeOpenQuestionWatch(ledger, null, () => {})).toBeNull()
    expect(PREPARED_QUESTION).toContain('?')
  })
})

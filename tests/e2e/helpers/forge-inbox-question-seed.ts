/**
 * Seeds one open question into a profile's forge ledger, asked by a task rather than written by
 * the host. The question goes through the real preparation drain, so the seeded row has the same
 * shape the app produces.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { FORGE_INBOX_LEDGER_FILE } from '../../../src/main/forge-inbox/forge-inbox-host-startup'
import { ForgeInboxLedger } from '../../../src/main/forge-inbox/forge-inbox-ledger'
import { admitProjectEventDelivery } from '../../../src/main/forge-inbox/forge-inbox-project-event-delivery'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from '../../../src/main/forge-inbox/forge-inbox-project-event-decision'
import { fakeStore } from '../../../src/main/forge-inbox/forge-inbox-project-binding-test-fixture'
import {
  projectEventQuestionBody,
  projectEventQuestionDecision,
  seedProjectEventQuestionPolicy
} from '../../../src/main/forge-inbox/forge-inbox-project-event-question-test-kit'
import { openQuestionPreparationHarness } from '../../../src/main/forge-inbox/forge-inbox-project-event-question-preparation-test-kit'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from '../../../src/main/forge-inbox/forge-inbox-webhook-queue'

export async function seedTaskAskedQuestion(
  profileDir: string,
  question: string
): Promise<{ ownerHostId: string; itemId: number }> {
  // Why: the app adopts the persisted owner, so a seeded ledger has to be openable by it.
  const ledger = ForgeInboxLedger.open(join(profileDir, FORGE_INBOX_LEDGER_FILE), {
    now: () => Date.now(),
    secretStore: fakeStore()
  })
  try {
    const ctx = ledger.ledgerContext()
    const bindingId = seedProjectEventQuestionPolicy(ctx)
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Merge Request Hook',
      dedupeKey: `e2e-${randomUUID()}`,
      correlation: { eventUuid: null, configUuid: null },
      body: projectEventQuestionBody()
    })
    if (!admitted.ok) {
      throw new Error(`could not admit the seeded delivery: ${admitted.reason}`)
    }
    const claim = claimProjectEventDecision(ctx)
    if (!claim) {
      throw new Error('the seeded delivery was not decided')
    }
    const decided = decideProjectEventDelivery(
      ctx,
      admitted.deliveryId,
      projectEventQuestionDecision('ask_user'),
      claim
    )
    if (!decided.ok) {
      throw new Error(`could not record the ask_user decision: ${decided.reason}`)
    }
    const harness = openQuestionPreparationHarness(ledger, { question })
    try {
      const drained = await harness.drain()
      if (drained.executed !== 1 || drained.failed !== 0) {
        throw new Error(`the seeded question was not published: ${JSON.stringify(drained)}`)
      }
      await harness.complete()
    } finally {
      harness.dispose()
    }
    const row = ctx.db
      .prepare('SELECT id, item_id, source, status FROM project_event_questions')
      .get()
    if (!row || row.source !== 'answer' || row.status !== 'open') {
      throw new Error('the seeded question is not an open question a task asked')
    }
    return { ownerHostId: ledger.hostId, itemId: Number(row.item_id) }
  } finally {
    ledger.close()
  }
}

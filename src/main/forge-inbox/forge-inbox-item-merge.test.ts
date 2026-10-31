import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DispatchReportCapture } from './forge-inbox-dispatch-report'
import {
  CONFIRMATION_TEST_SHA,
  seedDispatchRun
} from './forge-inbox-dispatch-confirmation-test-kit'
import { mergeForgeItem } from './forge-inbox-item-merge'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { createWebhookHarness, type WebhookHarness } from './forge-inbox-webhook-test-harness'

const BINDING = { bindingId: 'binding-1', gitlabHost: 'gitlab.test', gitlabProjectId: 3 }
const SCOPE = { instanceId: 'gitlab:gitlab.test' }

function report(action: 'merge' | 'request-changes' | 'close' | 'none'): DispatchReportCapture {
  return {
    status: 'claims',
    mode: 'read-only',
    claims: [],
    recommendation: { action, reason: 'Docs only.' }
  }
}

describe('forge inbox item merge', () => {
  let harness: WebhookHarness
  afterEach(() => harness.dispose())

  function seeded(
    ledger: ForgeInboxLedger,
    options: { report: DispatchReportCapture | null; itemState?: string }
  ) {
    return seedDispatchRun(ledger.ledgerContext(), {
      binding: BINDING,
      report: options.report,
      storedIid: 7,
      expectedSha: CONFIRMATION_TEST_SHA,
      ...(options.itemState === undefined ? {} : { itemState: options.itemState })
    })
  }

  it('merges exactly the reviewed head and records the result', async () => {
    harness = createWebhookHarness()
    const ledger = harness.open()
    const { itemId } = seeded(ledger, { report: report('merge'), itemState: 'opened' })
    const merge = vi.fn(async () => ({ ok: true as const }))

    await expect(
      mergeForgeItem({ ledger, merge }, { scope: SCOPE, itemId }, new AbortController().signal)
    ).resolves.toEqual({ ok: true })
    expect(merge).toHaveBeenCalledWith(
      {
        instanceId: 'gitlab:gitlab.test',
        projectId: 'group/demo',
        kind: 'merge_request',
        iid: 7
      },
      CONFIRMATION_TEST_SHA,
      expect.any(AbortSignal)
    )
    const changes = ledger
      .ledgerContext()
      .db.prepare('SELECT change FROM changes WHERE item_id = ? ORDER BY seq DESC')
      .all(itemId)
    expect(changes[0]).toEqual({ change: 'merge-applied' })
  })

  it('refuses to merge when the run recommended changes instead', async () => {
    harness = createWebhookHarness()
    const ledger = harness.open()
    const { itemId } = seeded(ledger, { report: report('request-changes'), itemState: 'opened' })
    const merge = vi.fn(async () => ({ ok: true as const }))

    await expect(
      mergeForgeItem({ ledger, merge }, { scope: SCOPE, itemId }, new AbortController().signal)
    ).resolves.toEqual({ ok: false, reason: 'not-recommended' })
    expect(merge).not.toHaveBeenCalled()
  })

  it('refuses when no run left a recommendation', async () => {
    harness = createWebhookHarness()
    const ledger = harness.open()
    const { itemId } = seeded(ledger, { report: null, itemState: 'opened' })

    await expect(
      mergeForgeItem(
        { ledger, merge: vi.fn() },
        { scope: SCOPE, itemId },
        new AbortController().signal
      )
    ).resolves.toEqual({ ok: false, reason: 'no-recommendation' })
  })

  it('refuses a merge request that is no longer open', async () => {
    harness = createWebhookHarness()
    const ledger = harness.open()
    const { itemId } = seeded(ledger, { report: report('merge'), itemState: 'merged' })
    const merge = vi.fn(async () => ({ ok: true as const }))

    await expect(
      mergeForgeItem({ ledger, merge }, { scope: SCOPE, itemId }, new AbortController().signal)
    ).resolves.toEqual({ ok: false, reason: 'not-open' })
    expect(merge).not.toHaveBeenCalled()
  })

  it('reports a failed merge by its fixed code and still records the attempt', async () => {
    harness = createWebhookHarness()
    const ledger = harness.open()
    const { itemId } = seeded(ledger, { report: report('merge'), itemState: 'opened' })
    const merge = vi.fn(async () => ({
      ok: false as const,
      code: 'head-moved' as const,
      mayHaveLanded: false
    }))

    await expect(
      mergeForgeItem({ ledger, merge }, { scope: SCOPE, itemId }, new AbortController().signal)
    ).resolves.toEqual({ ok: false, reason: 'head-moved' })
    const changes = ledger
      .ledgerContext()
      .db.prepare('SELECT change FROM changes WHERE item_id = ? ORDER BY seq DESC')
      .all(itemId)
    expect(changes[0]).toEqual({ change: 'merge-failed' })
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

describe('forge inbox dispatched agent ownership', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let side: Database.Database

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger)
    side = new Database(harness.dbPath)
  })
  afterEach(() => {
    side.close()
    harness.dispose()
  })

  function run(reason: string, columns: string): void {
    const ingested = ledger.ingestEvent({
      hostId: 'host-a',
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      kind: 'merge_request',
      iid: 7,
      dedupeKey: `d-${reason}`,
      eventKind: 'merge_request.updated',
      payload: { n: 1 },
      versionToken: 'v1',
      sourceOrder: 1,
      title: 'Add thing',
      itemState: 'opened',
      queueRun: { reason }
    })
    if (ingested.duplicate || ingested.runId === null) {
      throw new Error('no run queued')
    }
    side.prepare(`UPDATE runs SET ${columns} WHERE id = ?`).run(ingested.runId)
  }

  it('recognises the structured session and terminal a project event dispatch started', () => {
    run('project-event-dispatch', "session_id = 'session-1', terminal_handle = 'term-1'")

    expect(ledger.isDispatchedAgent({ sessionId: 'session-1' })).toBe(true)
    expect(ledger.isDispatchedAgent({ terminalHandle: 'term-1' })).toBe(true)
  })

  it('does not claim an unrelated session, terminal or an empty identity', () => {
    run('project-event-dispatch', "session_id = 'session-1', terminal_handle = 'term-1'")

    expect(ledger.isDispatchedAgent({ sessionId: 'someone-elses' })).toBe(false)
    expect(ledger.isDispatchedAgent({ terminalHandle: 'term-9' })).toBe(false)
    expect(ledger.isDispatchedAgent({})).toBe(false)
  })

  it('ignores a run that was not a project event dispatch', () => {
    run('manual', "session_id = 'session-2', terminal_handle = 'term-2'")

    expect(ledger.isDispatchedAgent({ sessionId: 'session-2' })).toBe(false)
    expect(ledger.isDispatchedAgent({ terminalHandle: 'term-2' })).toBe(false)
  })
})

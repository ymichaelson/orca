import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { ForgeInboxCorruptError } from './forge-inbox-database'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeObservationInput } from './forge-inbox-observation'
import {
  createWebhookHarness,
  INSTANCE_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const TARGET = { instanceId: INSTANCE_ID, projectId: '42' }
const targetProject = { projectId: '42', repoId: 'repo-1', enabled: true, rules: 'v0' }
const otherProject = { projectId: '43', repoId: 'repo-2', enabled: true, rules: 'v0' }

describe('forge inbox run policy generation', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let order: number
  const items = new Map<string, number>()

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(
      ledger,
      webhookConfig([webhookInstance({ projects: [targetProject, otherProject] })])
    )
    order = 0
  })
  afterEach(() => harness.dispose())

  const observation = (projectId = '42', token = 'ctx-1'): ForgeObservationInput => {
    order += 1
    return {
      hostId: 'host-a',
      ...SCOPE,
      projectId,
      kind: 'merge_request',
      iid: 7,
      dedupeKey: `obs-${order}`,
      eventKind: 'gitlab.merge_request',
      payload: {},
      versionToken: token,
      title: 'Add thing',
      itemState: 'opened',
      queueRun: { reason: 'review-request' }
    }
  }
  const observe = (input: ForgeObservationInput) => {
    const result = ledger.ingestObservation(
      input,
      ledger.getConfig().configRevision,
      ledger.readProjectInvalidationGeneration({ ...SCOPE, projectId: input.projectId })
    )
    if (!result.ok || result.duplicate) {
      throw new Error('observation not ingested')
    }
    items.set(input.projectId, result.itemId)
    return result
  }
  const runs = (projectId = '42') =>
    ledger.listRuns(SCOPE, { itemId: items.get(projectId), limit: 50 }).rows.toReversed()
  const states = (projectId = '42') => runs(projectId).map((run) => run.state)
  const bump = () => {
    const rules = `rules-${order}-${Math.random()}`
    order += 1
    const result = ledger.updateProjectPolicy(ledger.getConfig().configRevision, {
      ...TARGET,
      patch: { rules }
    })
    expect(result.ok).toBe(true)
  }

  it('supersedes only the queued old-policy runs of the target project, keeping their generation', () => {
    const target = observe(observation('42'))
    observe(observation('43'))
    const queuedGeneration = ledger.getRun(target.runId!)!.policyGeneration

    bump()

    expect(states('42')).toEqual(['superseded'])
    expect(ledger.getRun(target.runId!)?.policyGeneration).toBe(queuedGeneration)
    expect(states('43')).toEqual(['queued'])
  })

  it('records the policy generation at queue time and dedupes only within the current one', () => {
    const first = observe(observation())
    const generation = ledger.getRun(first.runId!)!.policyGeneration
    expect(generation).toEqual(expect.any(Number))

    observe(observation('42', 'ctx-1'))
    expect(states()).toEqual(['queued'])

    bump()
    expect(states()).toEqual(['superseded'])
    const rebound = observe(observation('42', 'ctx-1'))
    expect(ledger.getRun(rebound.runId!)?.policyGeneration).toBe(generation + 1)
    expect(states()).toEqual(['superseded', 'queued'])

    observe(observation('42', 'ctx-1'))
    expect(states()).toEqual(['superseded', 'queued'])
  })

  it('lets a finished or running old-generation run neither block nor get cancelled by a new one', () => {
    observe(observation())
    const running = ledger.claimNextQueuedRun(SCOPE)!
    expect(running.state).toBe('running')

    bump()
    expect(ledger.getRun(running.id)?.state).toBe('running')
    observe(observation('42', 'ctx-1'))

    expect(states()).toEqual(['running', 'queued'])
    observe(observation('42', 'ctx-1'))
    expect(states()).toEqual(['running', 'queued'])
  })

  it('rolls the config, policy generation and queued run back together when the bump fails', () => {
    const target = observe(observation())
    const before = ledger.getConfig()
    const raw = new Database(harness.dbPath)
    raw.exec(
      "CREATE TRIGGER fail_run_update BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'boom'); END"
    )
    raw.close()

    expect(() =>
      ledger.updateProjectPolicy(before.configRevision, { ...TARGET, patch: { rules: 'next' } })
    ).toThrow()

    expect(ledger.getConfig()).toEqual(before)
    expect(ledger.getRun(target.runId!)?.state).toBe('queued')
    const cleanup = new Database(harness.dbPath)
    cleanup.exec('DROP TRIGGER fail_run_update')
    cleanup.close()
    expect(ledger.bumpPolicyGeneration(TARGET)).toBe(
      ledger.getRun(target.runId!)!.policyGeneration + 1
    )
  })

  it('refuses a pre-release file whose runs table lacks the policy column, leaving it untouched', () => {
    ledger.close()
    const raw = new Database(harness.dbPath)
    // SQLite refuses to drop a column an index still covers.
    raw.exec('DROP INDEX runs_by_context')
    raw.exec('DROP INDEX runs_one_active_per_context')
    raw.exec('ALTER TABLE runs DROP COLUMN policy_generation')
    raw.close()
    const before = readFileSync(harness.dbPath)

    expect(() => harness.open()).toThrow(ForgeInboxCorruptError)

    expect(readFileSync(harness.dbPath)).toEqual(before)
  })
})

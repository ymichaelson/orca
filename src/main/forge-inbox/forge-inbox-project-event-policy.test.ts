import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecretStore } from '../../shared/secret-store'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { getProjectEventPolicy, updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'

const DEFAULT_EVENTS = {
  reviewRequests: false,
  participatingMergeRequestUpdates: false,
  pipelineFailures: false,
  issueMentions: false,
  issueAssignments: false
}

const DEFAULT_BUDGETS = {
  timeoutSeconds: 600,
  maxInputTokens: 100_000,
  maxOutputTokens: 8_000,
  maxRunsPerHour: 12,
  maxConcurrentRuns: 1
}

describe('project event policy store', () => {
  let root: string
  let dbPath: string
  let clock: number
  let store: SecretStore
  let ctx: ForgeLedgerContext

  const open = (): ForgeLedgerContext => {
    const opened = openForgeInboxDatabase(dbPath, 'host-1')
    return {
      db: opened.db,
      hostId: opened.hostId,
      now: () => ++clock,
      secretStore: () => store
    }
  }

  const save = (repoId: string, expectedGeneration: number, patch: unknown) =>
    updateProjectEventPolicy(ctx, { repoId, expectedGeneration, patch })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-policy-'))
    dbPath = join(root, 'forge-inbox.sqlite')
    clock = 1000
    store = fakeStore()
    ctx = open()
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('saves a repository policy synchronously, before any GitLab identity exists', () => {
    const result = save('repo-1', 0, { rules: 'Prefer focused diffs', enabled: true })

    expect(result).not.toBeInstanceOf(Promise)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.generation).toBe(1)
    expect(result.policy).toMatchObject({
      repoId: 'repo-1',
      agentId: null,
      model: null,
      rules: 'Prefer focused diffs',
      enabled: true,
      automaticAnalysis: false,
      generation: 1
    })
    expect(result.policy.events).toEqual(DEFAULT_EVENTS)
    expect(result.policy.budgets).toEqual(DEFAULT_BUDGETS)
    expect('workspaceId' in result.policy).toBe(false)
    expect(getProjectEventPolicy(ctx, 'repo-1')).toEqual(result.policy)
    expect(getProjectEventPolicy(ctx, 'repo-2')).toBeNull()
  })

  it('does not bump the generation for a no-op save', () => {
    const first = save('repo-1', 0, { rules: 'Prefer focused diffs', enabled: true })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }

    const second = save('repo-1', first.generation, { rules: 'Prefer focused diffs' })

    expect(second.ok).toBe(true)
    if (!second.ok) {
      return
    }
    expect(second.generation).toBe(first.generation)
    expect(second.policy.rules).toBe('Prefer focused diffs')
    expect(second.policy.enabled).toBe(true)
  })

  it('bumps the generation only on a real change and rejects a stale expectation', () => {
    const first = save('repo-1', 0, { enabled: true })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }

    const second = save('repo-1', first.generation, { enabled: false })
    expect(second.ok).toBe(true)
    if (!second.ok) {
      return
    }
    expect(second.generation).toBe(first.generation + 1)
    expect(second.policy.enabled).toBe(false)

    const stale = save('repo-1', first.generation, { rules: 'late writer' })
    expect(stale.ok).toBe(false)
    if (stale.ok) {
      return
    }
    expect(stale).toEqual({
      ok: false,
      reason: 'stale-generation',
      generation: second.generation
    })
    expect(getProjectEventPolicy(ctx, 'repo-1')?.rules).toBe('')
  })

  it('merges event and budget patches without resetting their siblings', () => {
    const first = save('repo-1', 0, {
      events: { pipelineFailures: true },
      budgets: { maxRunsPerHour: 5 }
    })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    expect(first.policy.events).toEqual({ ...DEFAULT_EVENTS, pipelineFailures: true })
    expect(first.policy.budgets).toEqual({ ...DEFAULT_BUDGETS, maxRunsPerHour: 5 })

    const second = save('repo-1', first.generation, { events: { reviewRequests: true } })
    expect(second.ok).toBe(true)
    if (!second.ok) {
      return
    }
    expect(second.policy.events).toEqual({
      ...DEFAULT_EVENTS,
      pipelineFailures: true,
      reviewRequests: true
    })
    expect(second.policy.budgets).toEqual({ ...DEFAULT_BUDGETS, maxRunsPerHour: 5 })
  })

  it('rejects a rules value over the UTF-8 byte cap and keeps the stored policy', () => {
    const first = save('repo-1', 0, { rules: 'short' })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }

    const oversized = 'é'.repeat(8193)
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(16 * 1024)
    const rejected = save('repo-1', first.generation, { rules: oversized })

    expect(rejected.ok).toBe(false)
    if (rejected.ok) {
      return
    }
    expect(rejected.reason).toBe('invalid-policy')
    expect(getProjectEventPolicy(ctx, 'repo-1')).toMatchObject({
      rules: 'short',
      generation: first.generation
    })
  })

  it('rejects unknown keys and automatic analysis without an agent and model', () => {
    const unknown = save('repo-1', 0, { surprise: true })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.reason).toBe('invalid-policy')
    }
    expect(getProjectEventPolicy(ctx, 'repo-1')).toBeNull()

    const incomplete = save('repo-1', 0, { automaticAnalysis: true })
    expect(incomplete.ok).toBe(false)
    if (!incomplete.ok) {
      expect(incomplete.reason).toBe('invalid-policy')
    }

    const complete = save('repo-1', 0, {
      agentId: 'claude',
      model: 'claude-sonnet-5-5',
      automaticAnalysis: true
    })
    expect(complete.ok).toBe(true)
    if (!complete.ok) {
      return
    }

    const cleared = save('repo-1', complete.generation, { agentId: null })
    expect(cleared.ok).toBe(false)
    if (!cleared.ok) {
      expect(cleared.reason).toBe('invalid-policy')
    }
    expect(getProjectEventPolicy(ctx, 'repo-1')?.agentId).toBe('claude')
  })

  it('keeps generation and content isolated per repository', () => {
    const one = save('repo-1', 0, { rules: 'one' })
    const two = save('repo-2', 0, { rules: 'two' })
    expect(one.ok && two.ok).toBe(true)
    if (!one.ok || !two.ok) {
      return
    }
    expect(one.generation).toBe(1)
    expect(two.generation).toBe(1)

    const oneAgain = save('repo-1', one.generation, { rules: 'one changed' })
    expect(oneAgain.ok).toBe(true)
    expect(getProjectEventPolicy(ctx, 'repo-2')).toMatchObject({
      rules: 'two',
      generation: 1
    })
  })
})

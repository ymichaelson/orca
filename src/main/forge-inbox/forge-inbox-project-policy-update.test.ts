import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createWebhookHarness,
  INSTANCE_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const TARGET = { instanceId: INSTANCE_ID, projectId: '42' }
const OTHER = { instanceId: INSTANCE_ID, projectId: '43' }
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

const targetProject = {
  projectId: '42',
  repoId: 'repo-1',
  workspaceId: 'ws-1',
  agentId: 'codex',
  model: 'gpt-fake',
  rules: 'be kind',
  enabled: true,
  automaticAnalysis: true,
  events: { reviewRequests: true, issueMentions: true },
  budgets: { timeoutSeconds: 900, maxRunsPerHour: 3 }
}
const otherProject = { projectId: '43', repoId: 'repo-2', enabled: true, rules: 'other rules' }

describe('forge inbox project policy update', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let hints: { changes: boolean }[]

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(
      ledger,
      webhookConfig([
        webhookInstance({ usernames: ['me'], projects: [targetProject, otherProject] })
      ])
    )
    hints = []
    ledger.onCommitted((hint) => hints.push(hint))
  })
  afterEach(() => harness.dispose())

  const project = (id: string) =>
    ledger.getConfig().config.instances[0].projects.find((candidate) => candidate.projectId === id)
  const update = (patch: Record<string, unknown>, revision = ledger.getConfig().configRevision) =>
    ledger.updateProjectPolicy(revision, { ...TARGET, patch })

  function pendingProposal(projectId: string, token: string) {
    const ingested = ledger.ingestEvent({
      hostId: 'host-a',
      ...SCOPE,
      projectId,
      kind: 'merge_request',
      iid: Number(projectId),
      dedupeKey: `d-${token}`,
      eventKind: 'merge_request.updated',
      payload: {},
      versionToken: 'v1',
      sourceOrder: 1,
      title: 't',
      itemState: 'opened',
      queueRun: { reason: 'x' }
    })
    const claimed = ledger.claimNextQueuedRun(SCOPE)
    if (ingested.duplicate || !claimed || ingested.runId === null) {
      throw new Error('no run claimed')
    }
    const made = ledger.createProposal({
      runId: claimed.id,
      expectedGeneration: claimed.generation,
      body: { comment: 'hi' }
    })
    if (!made.ok) {
      throw new Error(made.reason)
    }
    return made.proposal.id
  }

  it('merges scalars and one level of events and budgets without resetting omitted settings', () => {
    const before = ledger.getConfig()

    const result = update({
      rules: 'new rules',
      events: { issueMentions: false },
      budgets: { maxRunsPerHour: 5 }
    })

    expect(result).toEqual({ ok: true, configRevision: before.configRevision + 1 })
    expect(project('42')).toEqual({
      ...before.config.instances[0].projects[0],
      rules: 'new rules',
      events: { ...before.config.instances[0].projects[0].events, issueMentions: false },
      budgets: { ...before.config.instances[0].projects[0].budgets, maxRunsPerHour: 5 }
    })
    expect(project('42')).toMatchObject({
      automaticAnalysis: true,
      agentId: 'codex',
      model: 'gpt-fake',
      enabled: true,
      events: { reviewRequests: true },
      budgets: { timeoutSeconds: 900 }
    })
    expect(project('43')).toEqual(before.config.instances[0].projects[1])
    expect(ledger.getConfig().config.instances[0].usernames).toEqual(['me'])
  })

  it('clears the model with null and enforces the full config rules without any change', async () => {
    const before = ledger.getConfig()
    await settle()
    hints.length = 0

    const result = update({ model: null })

    expect(result).toMatchObject({ ok: false, reason: 'invalid-config' })
    expect(ledger.getConfig()).toEqual(before)
    await settle()
    expect(hints).toEqual([])

    expect(update({ model: null, automaticAnalysis: false })).toMatchObject({ ok: true })
    expect(project('42')?.model).toBeUndefined()
    expect(project('42')?.agentId).toBe('codex')
  })

  it.each([
    ['repoId', { repoId: 'elsewhere' }],
    ['workspaceId', { workspaceId: 'ws-2' }],
    ['projectId', { projectId: '43' }],
    ['usernames', { usernames: ['evil'] }],
    ['baseUrl', { baseUrl: 'https://evil.example.com' }],
    ['listener', { listener: { enabled: true } }],
    ['unknown key', { surprise: true }],
    ['out of range budget', { budgets: { timeoutSeconds: 1 } }]
  ])('rejects a patch with %s and changes nothing', async (_name, patch) => {
    const before = ledger.getConfig()

    expect(update(patch)).toMatchObject({ ok: false, reason: 'invalid-config' })

    expect(ledger.getConfig()).toEqual(before)
    await settle()
    expect(hints).toEqual([])
  })

  it('bounds rules by UTF-8 bytes before reading any config', () => {
    const stale = ledger.getConfig().configRevision - 1

    expect(update({ rules: '\u00e9'.repeat(8193) }, stale)).toMatchObject({
      ok: false,
      reason: 'invalid-config'
    })
    expect(update({ rules: 'a'.repeat(16385) }, stale)).toMatchObject({
      ok: false,
      reason: 'invalid-config'
    })
    expect(update({ rules: '\u00e9'.repeat(8192) })).toMatchObject({ ok: true })
  })

  it.each([
    ['an inherited-looking nested key', '{"events":{"__proto__":{"reviewRequests":false}}}'],
    ['an unknown events key', '{"events":{"surprise":true}}'],
    ['an unknown budgets key', '{"budgets":{"surprise":1}}']
  ])('rejects %s in a parsed patch and leaves the config alone', (_name, json) => {
    const before = ledger.getConfig()

    expect(update(JSON.parse(json))).toMatchObject({ ok: false, reason: 'invalid-config' })

    expect(ledger.getConfig()).toEqual(before)
    expect(Object.getPrototypeOf(project('42')?.events)).toBe(Object.prototype)
  })

  it('reports a stale revision with the current one and changes nothing', async () => {
    const before = ledger.getConfig()

    const result = update({ rules: 'x' }, before.configRevision - 1)

    expect(result).toEqual({
      ok: false,
      reason: 'stale-revision',
      configRevision: before.configRevision
    })
    expect(ledger.getConfig()).toEqual(before)
    await settle()
    expect(hints).toEqual([])
  })

  it.each([
    ['an empty patch', TARGET, {}],
    [
      'values equal to the current ones',
      TARGET,
      { rules: 'be kind', events: { reviewRequests: true } }
    ],
    ['a null clear of an already unset field', OTHER, { model: null }]
  ])('treats %s as a no-op: no revision bump, revocation or hint', async (_name, scope, patch) => {
    const proposal = pendingProposal('42', 'a')
    await settle()
    hints.length = 0
    const before = ledger.getConfig()

    const result = ledger.updateProjectPolicy(before.configRevision, { ...scope, patch })

    expect(result).toEqual({ ok: true, configRevision: before.configRevision })
    expect(ledger.getConfig()).toEqual(before)
    expect(ledger.getProposal(proposal)?.status).toBe('pending')
    await settle()
    expect(hints).toEqual([])
  })

  it('checks the revision before recognising a no-op', () => {
    const before = ledger.getConfig()

    expect(update({}, before.configRevision - 1)).toMatchObject({
      ok: false,
      reason: 'stale-revision'
    })
  })

  it('never creates a project that is not already allowlisted', () => {
    const before = ledger.getConfig()

    const result = ledger.updateProjectPolicy(before.configRevision, {
      instanceId: INSTANCE_ID,
      projectId: '99',
      patch: { rules: 'x' }
    })

    expect(result).toMatchObject({ ok: false, reason: 'project-not-found' })
    expect(ledger.getConfig()).toEqual(before)
  })

  it('revokes only the target project proposals and wakes subscribers once', async () => {
    const targetProposal = pendingProposal('42', 'a')
    const otherProposal = pendingProposal('43', 'b')
    await settle()
    hints.length = 0
    const generationBefore = ledger.getConfig().configRevision

    expect(update({ rules: 'tightened' })).toMatchObject({ ok: true })

    expect(ledger.getProposal(targetProposal)?.status).toBe('stale')
    expect(ledger.getProposal(otherProposal)?.status).toBe('pending')
    expect(ledger.getConfig().configRevision).toBe(generationBefore + 1)
    await settle()
    expect(hints).toEqual([{ changes: true, readClientIds: [] }])
  })

  it('rolls the config and the revocation back together when the revocation fails', () => {
    const proposal = pendingProposal('42', 'a')
    const before = ledger.getConfig()
    const side = new Database(harness.dbPath)
    side.exec(
      `CREATE TRIGGER fail_revoke BEFORE INSERT ON changes WHEN NEW.entity = 'proposal'
       BEGIN SELECT RAISE(ABORT, 'injected'); END`
    )
    side.close()

    expect(() => update({ rules: 'tightened' })).toThrow(/injected/)

    expect(ledger.getConfig()).toEqual(before)
    expect(ledger.getProposal(proposal)?.status).toBe('pending')
  })

  it('keeps the other project untouched when patching it', () => {
    const before = project('42')

    expect(
      ledger.updateProjectPolicy(ledger.getConfig().configRevision, {
        ...OTHER,
        patch: { enabled: false }
      })
    ).toMatchObject({ ok: true })

    expect(project('43')?.enabled).toBe(false)
    expect(project('42')).toEqual(before)
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeCommentTarget } from './forge-inbox-comment-draft'
import {
  forgeCommentMarker,
  hashForgeCommentDraft,
  parseForgeCommentDraft
} from './forge-inbox-comment-draft'
import { createForgeCommentBroker } from './forge-inbox-comment-broker'
import { approveForgeComment, createForgeCommentProposal } from './forge-inbox-comment-proposal'
import { createFakeGitlab } from './forge-inbox-gitlab-fake-server'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createWebhookHarness,
  fakeSecretStore,
  INSTANCE_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const HEAD = 'a'.repeat(40)
const WRITE_TOKEN = 'glpat-SECRET-write'
const READ_TOKEN = 'glpat-SECRET-read'
const SIGNAL = new AbortController().signal

function target(overrides: Partial<ForgeCommentTarget> = {}): ForgeCommentTarget {
  return { instanceId: INSTANCE_ID, projectId: '42', kind: 'merge_request', iid: 7, ...overrides }
}

describe('forge comment broker', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(
      ledger,
      webhookConfig([
        webhookInstance({
          projects: [{ projectId: '42', repoId: 'repo-1', workspaceId: 'ws-1', enabled: true }]
        })
      ])
    )
  })
  afterEach(() => {
    harness.dispose()
  })

  function setCredential(kind: 'api-read' | 'api-write', secret: string): void {
    const stored = ledger.setCredential({
      instanceId: INSTANCE_ID,
      kind,
      secret,
      expectedRevision: ledger.getConfig().configRevision
    })
    if (!stored.ok) {
      throw new Error(`credential rejected: ${stored.reason}`)
    }
  }

  function approvedComment(overrides: { body?: string } = {}): {
    proposalId: number
    hash: string
  } {
    const observed = ledger.ingestObservation(
      {
        hostId: ledger.hostId,
        ...SCOPE,
        projectId: '42',
        kind: 'merge_request',
        iid: 7,
        dedupeKey: 'd-1',
        eventKind: 'merge_request.review_requested',
        payload: {},
        versionToken: 'sha256:v1',
        queueRun: { reason: 'review-request' }
      },
      ledger.getConfig().configRevision,
      0
    )
    if (!observed.ok || observed.duplicate || observed.runId === null) {
      throw new Error(`unexpected observation outcome ${JSON.stringify(observed)}`)
    }
    ledger.transitionRun(observed.runId, { to: 'running' })
    const run = ledger.getRun(observed.runId)
    if (!run) {
      throw new Error('run vanished')
    }
    const created = createForgeCommentProposal(
      { ledger },
      {
        scope: SCOPE,
        runId: run.id,
        expectedGeneration: run.generation,
        draft: {
          target: target(),
          headSha: HEAD,
          body: overrides.body ?? 'Looks good to me.'
        }
      }
    )
    if (!created.ok) {
      throw new Error(`proposal rejected: ${created.reason}`)
    }
    return { proposalId: created.proposal.id, hash: created.hash }
  }

  async function approve(proposalId: number): Promise<void> {
    const proposal = ledger.getProposal(proposalId)
    if (!proposal) {
      throw new Error('proposal vanished')
    }
    const approved = await approveForgeComment(
      { ledger, readHead: async () => ({ ok: true, sha: HEAD }) },
      {
        scope: SCOPE,
        proposalId,
        expectedHash: hashOf(proposal.body),
        expectedRevision: proposal.revision,
        expectedPolicyGeneration: proposal.policyGeneration
      },
      SIGNAL
    )
    if (!approved.ok) {
      throw new Error(`approval refused: ${approved.reason}`)
    }
  }

  // The stored body is the draft; the hash is rebuilt from it exactly as the client displayed it.
  function hashOf(body: unknown): string {
    const draft = parseForgeCommentDraft(body)
    if (!draft) {
      throw new Error('stored proposal is not a comment draft')
    }
    return hashForgeCommentDraft(draft)
  }

  it('publishes the approved draft once with the api-write credential', async () => {
    setCredential('api-read', READ_TOKEN)
    setCredential('api-write', WRITE_TOKEN)
    const comment = approvedComment()
    await approve(comment.proposalId)
    const fake = createFakeGitlab()
    const broker = createForgeCommentBroker({ ledger, http: { fetch: fake.fetch } })

    const result = await broker.publish(
      { scope: SCOPE, expectedHash: comment.hash, proposalId: comment.proposalId },
      SIGNAL
    )

    expect(result).toMatchObject({ kind: 'published', noteId: 701 })
    expect(fake.writes).toHaveLength(1)
    expect(fake.writes[0]?.path).toBe('/merge_requests/7/notes')
    expect(fake.writes[0]?.headers['private-token']).toBe(WRITE_TOKEN)
    expect(JSON.parse(fake.writes[0]?.body ?? '{}')).toEqual({
      body: `Looks good to me.\n\n${forgeCommentMarker(comment.proposalId, comment.hash)}`
    })
  })

  it('never posts twice for the same approval', async () => {
    setCredential('api-read', READ_TOKEN)
    setCredential('api-write', WRITE_TOKEN)
    const comment = approvedComment()
    await approve(comment.proposalId)
    const fake = createFakeGitlab()
    const broker = createForgeCommentBroker({ ledger, http: { fetch: fake.fetch } })

    const first = await broker.publish(
      { scope: SCOPE, expectedHash: comment.hash, proposalId: comment.proposalId },
      SIGNAL
    )
    const second = await broker.publish(
      { scope: SCOPE, expectedHash: comment.hash, proposalId: comment.proposalId },
      SIGNAL
    )

    expect(second).toEqual(first)
    expect(fake.writes).toHaveLength(1)
  })

  it('reconciles an ambiguous delivery with the api-read credential instead of reposting', async () => {
    setCredential('api-read', READ_TOKEN)
    setCredential('api-write', WRITE_TOKEN)
    const comment = approvedComment()
    await approve(comment.proposalId)
    const fake = createFakeGitlab()
    const seen: RequestInit[] = []
    const broker = createForgeCommentBroker({
      ledger,
      http: {
        fetch: async (url: string, init: RequestInit = {}) => {
          seen.push(init)
          if ((init.method ?? 'GET') === 'POST') {
            throw new Error('socket hang up')
          }
          return fake.fetch(url, init)
        }
      }
    })

    const result = await broker.publish(
      { scope: SCOPE, expectedHash: comment.hash, proposalId: comment.proposalId },
      SIGNAL
    )

    expect(result).toMatchObject({ kind: 'unknown', reason: 'marker-not-found' })
    const read = seen.find((request) => (request.method ?? 'GET') === 'GET')
    expect(new Headers(read?.headers).get('private-token')).toBe(READ_TOKEN)
    expect(seen.filter((request) => request.method === 'POST')).toHaveLength(1)
  })

  it('fails without a write credential and never reaches the forge', async () => {
    setCredential('api-read', READ_TOKEN)
    const comment = approvedComment()
    await approve(comment.proposalId)
    const fake = createFakeGitlab()
    const broker = createForgeCommentBroker({ ledger, http: { fetch: fake.fetch } })

    await expect(
      broker.publish(
        { scope: SCOPE, expectedHash: comment.hash, proposalId: comment.proposalId },
        SIGNAL
      )
    ).resolves.toMatchObject({
      kind: 'failed',
      reason: 'no-credential'
    })
    expect(fake.writes).toHaveLength(0)
    expect(fake.requests).toHaveLength(0)
  })

  it('treats an unreadable credential envelope as a missing credential', async () => {
    setCredential('api-read', READ_TOKEN)
    setCredential('api-write', WRITE_TOKEN)
    const comment = approvedComment()
    await approve(comment.proposalId)
    ledger.close()
    ledger = harness.open({
      secretStore: { ...fakeSecretStore(), isEncryptionAvailable: () => false }
    })
    const fake = createFakeGitlab()
    const broker = createForgeCommentBroker({ ledger, http: { fetch: fake.fetch } })

    await expect(
      broker.publish(
        { scope: SCOPE, expectedHash: comment.hash, proposalId: comment.proposalId },
        SIGNAL
      )
    ).resolves.toMatchObject({
      kind: 'failed',
      reason: 'no-credential'
    })
    expect(fake.writes).toHaveLength(0)
  })

  it('refuses an unapproved proposal before any credential or network use', async () => {
    setCredential('api-read', READ_TOKEN)
    setCredential('api-write', WRITE_TOKEN)
    const comment = approvedComment()
    const fake = createFakeGitlab()
    const broker = createForgeCommentBroker({ ledger, http: { fetch: fake.fetch } })

    await expect(
      broker.publish(
        { scope: SCOPE, expectedHash: comment.hash, proposalId: comment.proposalId },
        SIGNAL
      )
    ).resolves.toEqual({
      kind: 'refused',
      reason: 'not-approved'
    })
    expect(fake.requests).toHaveLength(0)
  })
})

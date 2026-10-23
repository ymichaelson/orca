import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildForgePatchDraft,
  hashForgePatchDraft,
  parseForgePatchDraft,
  sha256OfContent,
  type ForgePatchDraft,
  type ForgePatchOperation
} from './forge-inbox-patch-draft'
import {
  approveForgePatch,
  createForgePatchProposal,
  type ForgePatchHeadReader
} from './forge-inbox-patch-proposal'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createWebhookHarness,
  INSTANCE_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const BASE = 'a'.repeat(40)
const NEXT_BASE = 'b'.repeat(40)
const TARGET = { instanceId: INSTANCE_ID, projectId: '42' }

function project(overrides: Record<string, unknown> = {}) {
  return { projectId: '42', repoId: 'repo-1', workspaceId: 'ws-1', enabled: true, ...overrides }
}

function operations(): ForgePatchOperation[] {
  return [
    {
      op: 'update',
      path: 'src/a.ts',
      baseSha256: sha256OfContent('old\n'),
      content: 'new\n',
      resultSha256: sha256OfContent('new\n')
    },
    { op: 'create', path: 'src/b.ts', content: 'b\n', resultSha256: sha256OfContent('b\n') }
  ]
}

function patchDraft(
  overrides: {
    target?: typeof TARGET
    operations?: ForgePatchOperation[]
    branch?: string
  } = {}
): ForgePatchDraft {
  const built = buildForgePatchDraft({
    target: overrides.target ?? TARGET,
    baseSha: BASE,
    branch: overrides.branch ?? 'main',
    operations: overrides.operations ?? operations()
  })
  if (!built.ok) {
    throw new Error(`draft rejected: ${built.reason}`)
  }
  return built.draft
}

describe('forge inbox patch proposal', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger, webhookConfig([webhookInstance({ projects: [project()] })]))
  })
  afterEach(() => {
    ledger.close()
    harness.dispose()
  })

  function observe(sourceOrder = 1): number | null {
    const result = ledger.ingestObservation(
      {
        hostId: ledger.hostId,
        ...SCOPE,
        projectId: '42',
        kind: 'merge_request',
        iid: 7,
        dedupeKey: `d-${sourceOrder}`,
        eventKind: 'merge_request.review_requested',
        payload: {},
        versionToken: `sha256:v${sourceOrder}`,
        ...(sourceOrder === 1 ? { queueRun: { reason: 'review-request' } } : {})
      },
      ledger.getConfig().configRevision,
      0
    )
    if (!result.ok || result.duplicate) {
      throw new Error(`unexpected observation outcome ${JSON.stringify(result)}`)
    }
    return result.runId
  }

  function runningRun(): { runId: number; generation: number } {
    const runId = observe()
    if (runId === null) {
      throw new Error('observation did not queue a run')
    }
    ledger.transitionRun(runId, { to: 'running' })
    const run = ledger.getRun(runId)
    if (!run) {
      throw new Error('run vanished')
    }
    return { runId, generation: run.generation }
  }

  function createPatch(
    options: { draft?: ForgePatchDraft; generation?: number } = {}
  ): ReturnType<typeof createForgePatchProposal> {
    const run = runningRun()
    return createForgePatchProposal(
      { ledger },
      {
        scope: SCOPE,
        runId: run.runId,
        expectedGeneration: options.generation ?? run.generation,
        draft: options.draft ?? patchDraft()
      }
    )
  }

  function headReader(read: ForgePatchHeadReader = async () => ({ ok: true, sha: BASE })) {
    return vi.fn(read)
  }

  function storedHash(body: unknown): string {
    const parsed = parseForgePatchDraft(body)
    if (!parsed) {
      throw new Error('stored proposal is not a patch draft')
    }
    return hashForgePatchDraft(parsed)
  }

  function approve(input: {
    proposalId: number
    hash?: string
    revision?: number
    policyGeneration?: number
    readHead?: ReturnType<typeof headReader>
    scope?: { instanceId: string }
  }) {
    const proposal = ledger.getProposal(input.proposalId)
    if (!proposal) {
      throw new Error('proposal vanished')
    }
    return approveForgePatch(
      { ledger, readHead: input.readHead ?? headReader() },
      {
        scope: input.scope ?? SCOPE,
        proposalId: input.proposalId,
        expectedHash: input.hash ?? storedHash(proposal.body),
        expectedRevision: input.revision ?? proposal.revision,
        expectedPolicyGeneration: input.policyGeneration ?? proposal.policyGeneration
      },
      new AbortController().signal
    )
  }

  it('stores the exact manifest, its hash and the reviewed base', () => {
    const draft = patchDraft()
    const result = createPatch({ draft })
    if (!result.ok) {
      throw new Error(`unexpected refusal ${result.reason}`)
    }

    expect(result.proposal.status).toBe('pending')
    expect(result.proposal.body).toEqual(draft)
    expect(result.hash).toBe(hashForgePatchDraft(draft))
    expect(ledger.getProposal(result.proposal.id)?.body).toEqual(draft)
  })

  it('refuses a manifest aimed at another project than the run analysed', () => {
    const result = createPatch({
      draft: patchDraft({ target: { instanceId: INSTANCE_ID, projectId: '43' } })
    })

    expect(result).toEqual({ ok: false, reason: 'item-mismatch' })
  })

  it('refuses to create when the run generation moved', () => {
    expect(createPatch({ generation: 99 })).toEqual({ ok: false, reason: 'generation-mismatch' })
  })

  it('supersedes the pending patch when a newer one targets the same item', () => {
    const run = runningRun()
    const first = createForgePatchProposal(
      { ledger },
      {
        scope: SCOPE,
        runId: run.runId,
        expectedGeneration: run.generation,
        draft: patchDraft()
      }
    )
    const second = createForgePatchProposal(
      { ledger },
      {
        scope: SCOPE,
        runId: run.runId,
        expectedGeneration: run.generation,
        draft: patchDraft({ branch: 'feat/follow-up' })
      }
    )
    if (!first.ok || !second.ok) {
      throw new Error('unexpected refusal')
    }

    expect(ledger.getProposal(first.proposal.id)?.status).toBe('stale')
    expect(ledger.getProposal(second.proposal.id)?.status).toBe('pending')
  })

  it('refuses a hash the client did not actually see, before reading the branch head', async () => {
    const result = createPatch()
    if (!result.ok) {
      throw new Error('unexpected refusal')
    }
    const readHead = headReader()

    await expect(
      approve({ proposalId: result.proposal.id, hash: 'f'.repeat(64), readHead })
    ).resolves.toEqual({ ok: false, reason: 'draft-mismatch' })
    expect(readHead).not.toHaveBeenCalled()
    expect(ledger.getProposal(result.proposal.id)?.status).toBe('pending')
  })

  it('marks the patch stale when the branch head moved since the manifest', async () => {
    const result = createPatch()
    if (!result.ok) {
      throw new Error('unexpected refusal')
    }
    const readHead = headReader(async () => ({ ok: true, sha: NEXT_BASE }))

    await expect(approve({ proposalId: result.proposal.id, readHead })).resolves.toEqual({
      ok: false,
      reason: 'head-moved'
    })
    expect(readHead).toHaveBeenCalledWith(
      { instanceId: INSTANCE_ID, projectId: '42', branch: 'main' },
      expect.any(AbortSignal)
    )
    expect(ledger.getProposal(result.proposal.id)?.status).toBe('stale')
  })

  it('keeps the patch pending when the branch head cannot be read', async () => {
    const result = createPatch()
    if (!result.ok) {
      throw new Error('unexpected refusal')
    }
    const failing = headReader(async () => ({ ok: false, code: 'network' }))

    await expect(approve({ proposalId: result.proposal.id, readHead: failing })).resolves.toEqual({
      ok: false,
      reason: 'head-unavailable'
    })
    expect(ledger.getProposal(result.proposal.id)?.status).toBe('pending')

    await expect(approve({ proposalId: result.proposal.id })).resolves.toMatchObject({ ok: true })
  })

  it('consumes the approval exactly once', async () => {
    const result = createPatch()
    if (!result.ok) {
      throw new Error('unexpected refusal')
    }

    await expect(approve({ proposalId: result.proposal.id })).resolves.toMatchObject({
      ok: true,
      proposal: { status: 'consumed' }
    })
    await expect(approve({ proposalId: result.proposal.id })).resolves.toEqual({
      ok: false,
      reason: 'not-pending'
    })
  })

  it('refuses an approval for an item version that has already moved', async () => {
    const result = createPatch()
    if (!result.ok) {
      throw new Error('unexpected refusal')
    }
    observe(2)

    await expect(approve({ proposalId: result.proposal.id })).resolves.toEqual({
      ok: false,
      reason: 'stale'
    })
    expect(ledger.getProposal(result.proposal.id)?.status).toBe('stale')
  })

  it('refuses a proposal whose body is not a patch manifest', async () => {
    const run = runningRun()
    const created = ledger.createProposal({
      runId: run.runId,
      expectedGeneration: run.generation,
      body: { kind: 'comment', body: 'Looks good to me.' }
    })
    if (!created.ok) {
      throw new Error('unexpected refusal')
    }

    await expect(
      approveForgePatch(
        { ledger, readHead: headReader() },
        {
          scope: SCOPE,
          proposalId: created.proposal.id,
          expectedHash: 'f'.repeat(64),
          expectedRevision: created.proposal.revision,
          expectedPolicyGeneration: created.proposal.policyGeneration
        },
        new AbortController().signal
      )
    ).resolves.toEqual({ ok: false, reason: 'not-a-patch' })
  })

  it('refuses an approval from another instance scope', async () => {
    const result = createPatch()
    if (!result.ok) {
      throw new Error('unexpected refusal')
    }

    await expect(
      approve({ proposalId: result.proposal.id, scope: { instanceId: 'gitlab-other' } })
    ).resolves.toEqual({ ok: false, reason: 'not-found' })
    expect(ledger.getProposal(result.proposal.id)?.status).toBe('pending')
  })
})

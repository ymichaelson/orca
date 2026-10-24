import { afterEach, describe, expect, it } from 'vitest'
import { buildForgeCommentDraft } from './forge-inbox-comment-draft'
import { SHA_A } from './forge-inbox-gitlab-fake-server'
import { createForgeGitBlob } from './forge-inbox-git-objects'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { sha256OfContent, type ForgePatchOperation } from './forge-inbox-patch-draft'
import { createForgePatchProposal } from './forge-inbox-patch-proposal'
import {
  createOwnerFixture,
  seedLedger,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'
import { INSTANCE_ID, PROJECT_ID } from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const TARGET = { instanceId: INSTANCE_ID, projectId: PROJECT_ID }
const OPERATIONS: ForgePatchOperation[] = [
  {
    op: 'update',
    path: 'src/a.ts',
    baseSha256: sha256OfContent('old\n'),
    content: 'new\n',
    resultSha256: sha256OfContent('new\n')
  },
  { op: 'create', path: 'src/b.ts', content: 'b\n', resultSha256: sha256OfContent('b\n') }
]

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers }
  })

describe('forge inbox proposal diff through the owner service', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  type Seeded = {
    proposalId: number
    hash: string
  }

  async function seedProposal(
    body: { kind: 'patch' } | { kind: 'comment' } = { kind: 'patch' }
  ): Promise<Seeded> {
    fx = createOwnerFixture()
    await seedLedger(fx)
    const ledger = ForgeInboxLedger.open(fx.dbPath, { secretStore: fx.store })
    try {
      const observed = ledger.ingestObservation(
        {
          hostId: ledger.hostId,
          ...SCOPE,
          projectId: PROJECT_ID,
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
      if (body.kind === 'comment') {
        const built = buildForgeCommentDraft({
          target: { instanceId: INSTANCE_ID, projectId: PROJECT_ID, kind: 'merge_request', iid: 7 },
          headSha: SHA_A,
          body: 'Nit: rename this local.'
        })
        if (!built.ok) {
          throw new Error(`draft rejected: ${built.reason}`)
        }
        const made = ledger.createProposal({
          runId: run.id,
          expectedGeneration: run.generation,
          body: built.draft
        })
        if (!made.ok) {
          throw new Error(`proposal rejected: ${made.reason}`)
        }
        return { proposalId: made.proposal.id, hash: built.hash }
      }
      const created = createForgePatchProposal(
        { ledger },
        {
          scope: SCOPE,
          runId: run.id,
          expectedGeneration: run.generation,
          draft: { target: TARGET, baseSha: SHA_A, branch: 'main', operations: OPERATIONS }
        }
      )
      if (!created.ok) {
        throw new Error(`unexpected refusal ${created.reason}`)
      }
      return { proposalId: created.proposal.id, hash: created.hash }
    } finally {
      ledger.close()
    }
  }

  function serveBase(content = 'old\n'): void {
    fx.gitlab.state.override = (path) => {
      if (path === '/repository/tree') {
        return json(
          [
            {
              id: createForgeGitBlob(content).oid,
              name: 'a.ts',
              type: 'blob',
              mode: '100644',
              path: 'src/a.ts'
            }
          ],
          { 'x-next-page': '' }
        )
      }
      if (path === '/repository/files/src%2Fa.ts/raw') {
        return new Response(content, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return null
    }
  }

  it('renders the exact diff from the pinned base and names the hash it belongs to', async () => {
    const seeded = await seedProposal()
    serveBase()
    const service = fx.service()
    await service.start()

    const diff = await service.getProposalDiff(
      { scope: SCOPE, proposalId: seeded.proposalId },
      new AbortController().signal
    )

    expect(diff).toMatchObject({ ok: true, hash: seeded.hash })
    if (!diff?.ok) {
      throw new Error('expected a rendered diff')
    }
    expect(diff.text).toContain('-old')
    expect(diff.text).toContain('+new')
    expect(diff.text).toContain('+b')
    expect(fx.gitlab.requests).toEqual(
      expect.arrayContaining(['/repository/tree', '/repository/files/src%2Fa.ts/raw'])
    )
    const read = fx.gitlab.requests.find((path) => path.endsWith('/raw'))
    expect(read).toBe('/repository/files/src%2Fa.ts/raw')
  })

  it('refuses a diff whose base content no longer matches the approved hash', async () => {
    const seeded = await seedProposal()
    // The reviewed base hash belongs to a file the pinned commit no longer holds.
    serveBase('someone else wrote this\n')
    const service = fx.service()
    await service.start()

    const diff = await service.getProposalDiff(
      { scope: SCOPE, proposalId: seeded.proposalId },
      new AbortController().signal
    )

    expect(diff).toEqual({ ok: false, reason: 'base-mismatch' })
  })

  it('answers a non-patch proposal without asking GitLab for a base', async () => {
    const seeded = await seedProposal({ kind: 'comment' })
    const service = fx.service()
    await service.start()

    const diff = await service.getProposalDiff(
      { scope: SCOPE, proposalId: seeded.proposalId },
      new AbortController().signal
    )

    expect(diff).toEqual({ ok: false, reason: 'not-a-patch' })
    expect(fx.gitlab.requests).toEqual([])
  })

  it('refuses to render when the host has no read credential', async () => {
    const seeded = await seedProposal()
    serveBase()
    const service = fx.service()
    await service.start()
    const cleared = await service.clearCredential({
      instanceId: INSTANCE_ID,
      kind: 'api-read',
      expectedRevision: service.getConfig().configRevision
    })
    expect(cleared.ok).toBe(true)

    const diff = await service.getProposalDiff(
      { scope: SCOPE, proposalId: seeded.proposalId },
      new AbortController().signal
    )

    expect(diff).toEqual({ ok: false, reason: 'base-unavailable' })
    expect(fx.gitlab.requests).toEqual([])
  })

  it('refuses to render when the project is no longer configured', async () => {
    const seeded = await seedProposal()
    serveBase()
    const service = fx.service()
    await service.start()
    const current = service.getConfig()
    const updated = await service.updateConfig(current.configRevision, {
      ...current.config,
      instances: current.config.instances.map((instance) => ({ ...instance, projects: [] }))
    })
    expect(updated.ok).toBe(true)

    const diff = await service.getProposalDiff(
      { scope: SCOPE, proposalId: seeded.proposalId },
      new AbortController().signal
    )

    expect(diff).toEqual({ ok: false, reason: 'base-unavailable' })
    expect(fx.gitlab.requests).toEqual([])
  })

  it('answers a proposal outside the addressed instance with nothing', async () => {
    const seeded = await seedProposal()
    serveBase()
    const service = fx.service()
    await service.start()

    const diff = await service.getProposalDiff(
      { scope: { instanceId: 'gitlab-elsewhere' }, proposalId: seeded.proposalId },
      new AbortController().signal
    )

    expect(diff).toBeNull()
    expect(fx.gitlab.requests).toEqual([])
  })
})

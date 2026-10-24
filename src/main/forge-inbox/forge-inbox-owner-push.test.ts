import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createForgeGitBlob } from './forge-inbox-git-objects'
import { SHA_A, SHA_B } from './forge-inbox-gitlab-fake-server'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { createForgePatchProposal } from './forge-inbox-patch-proposal'
import { sha256OfContent } from './forge-inbox-patch-draft'
import {
  createOwnerFixture,
  seedLedger,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'
import { INSTANCE_ID, PROJECT_ID } from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const TARGET = { instanceId: INSTANCE_ID, projectId: PROJECT_ID }

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers }
  })

describe('forge inbox push through the owner service', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  /** A consumed patch with an applied receipt; without it no push may be proposed. */
  async function seedPatch(
    settle: 'applied' | 'failed' | 'pending' = 'applied'
  ): Promise<{ runId: number; patchProposalId: number }> {
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
      const created = createForgePatchProposal(
        { ledger },
        {
          scope: SCOPE,
          runId: run.id,
          expectedGeneration: run.generation,
          draft: {
            target: TARGET,
            baseSha: SHA_A,
            branch: 'main',
            operations: [
              {
                op: 'update',
                path: 'src/a.ts',
                baseSha256: sha256OfContent('old\n'),
                content: 'new\n',
                resultSha256: sha256OfContent('new\n')
              }
            ]
          }
        }
      )
      if (!created.ok) {
        throw new Error(`unexpected refusal ${created.reason}`)
      }
      if (settle !== 'pending') {
        const consumed = ledger.consumeProposal(created.proposal.id, {
          revision: created.proposal.revision,
          policyGeneration: created.proposal.policyGeneration
        })
        if (!consumed.ok) {
          throw new Error(`patch not consumed: ${consumed.reason}`)
        }
        const begun = ledger.beginReceipt({ proposalId: created.proposal.id })
        if (!begun.started) {
          throw new Error('patch receipt did not start')
        }
        ledger.finishReceipt(begun.receipt.id, { state: settle })
      }
      return { runId: run.id, patchProposalId: created.proposal.id }
    } finally {
      ledger.close()
    }
  }

  function servePushBase(overrides: { head?: string; user?: Response } = {}): void {
    fx.gitlab.state.override = (path) => {
      if (path === '/repository/branches/main') {
        return json({ name: 'main', commit: { id: overrides.head ?? SHA_A } })
      }
      if (path === '/repository/tree') {
        return json(
          [
            {
              id: createForgeGitBlob('old\n').oid,
              name: 'a.ts',
              type: 'blob',
              mode: '100644',
              path: 'src/a.ts'
            }
          ],
          { 'x-next-page': '' }
        )
      }
      if (path === '/api/v4/user') {
        return (
          overrides.user ??
          json({ id: 1, name: 'Orca Bot', username: 'me', email: 'bot@example.com' })
        )
      }
      if (path === '') {
        return json({
          id: Number(PROJECT_ID),
          http_url_to_repo: 'https://gitlab.example.com/a/b.git'
        })
      }
      return null
    }
  }

  async function propose(
    patch: { runId: number; patchProposalId: number },
    service = fx.service()
  ) {
    await service.start()
    return service.proposePush(
      {
        scope: SCOPE,
        runId: patch.runId,
        patchProposalId: patch.patchProposalId,
        message: 'Forge change\n'
      },
      new AbortController().signal
    )
  }

  it('proposes a push plan bound to the applied patch and the live branch head', async () => {
    const patch = await seedPatch()
    servePushBase()

    const result = await propose(patch)

    if (result.kind !== 'proposal') {
      throw new Error(`unexpected refusal ${result.reason}`)
    }
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(result.treeSha).toMatch(/^[0-9a-f]{40}$/)
    const [row] = fx.rows('SELECT status, body_json FROM proposals WHERE id = ?', result.proposalId)
    expect(row?.status).toBe('pending')
    const body = JSON.parse(String(row?.body_json))
    expect(body).toMatchObject({
      kind: 'push',
      patch: { proposalId: patch.patchProposalId },
      target: TARGET,
      branch: 'main',
      expectedHeadSha: SHA_A,
      commitSha: result.commitSha,
      commit: { author: { name: 'Orca Bot', email: 'bot@example.com' } }
    })
    expect(fx.gitlab.requests).toEqual(
      expect.arrayContaining(['/repository/branches/main', '/repository/tree', '/api/v4/user'])
    )
  })

  it('refuses a run that does not exist', async () => {
    const patch = await seedPatch()
    servePushBase()

    const result = await propose({ ...patch, runId: 999 })

    expect(result).toEqual({ kind: 'refused', reason: 'run-missing' })
    expect(fx.gitlab.requests).toEqual([])
  })

  it('refuses a patch that was never applied', async () => {
    const patch = await seedPatch('pending')
    servePushBase()

    expect(await propose(patch)).toEqual({ kind: 'refused', reason: 'patch-not-applied' })
    expect(fx.gitlab.requests).toEqual([])
  })

  it('refuses a patch whose application failed', async () => {
    const patch = await seedPatch('failed')
    servePushBase()

    expect(await propose(patch)).toEqual({ kind: 'refused', reason: 'patch-not-applied' })
    expect(fx.gitlab.requests).toEqual([])
  })

  it('refuses when the branch moved since the patch base', async () => {
    const patch = await seedPatch()
    servePushBase({ head: SHA_B })

    expect(await propose(patch)).toEqual({ kind: 'refused', reason: 'base-moved' })
  })

  it('refuses when the owner identity cannot be read', async () => {
    const patch = await seedPatch()
    servePushBase({ user: new Response('{"message":"404"}', { status: 404 }) })

    expect(await propose(patch)).toEqual({ kind: 'refused', reason: 'identity-unavailable' })
  })

  async function proposedPush(): Promise<{
    service: ReturnType<OwnerFixture['service']>
    push: {
      proposalId: number
      expectedHash: string
      expectedRevision: number
      expectedPolicyGeneration: number
    }
  }> {
    const patch = await seedPatch()
    servePushBase()
    const service = fx.service()
    const result = await propose(patch, service)
    if (result.kind !== 'proposal') {
      throw new Error(`unexpected refusal ${result.reason}`)
    }
    const [row] = fx.rows(
      'SELECT revision, policy_generation FROM proposals WHERE id = ?',
      result.proposalId
    )
    return {
      service,
      push: {
        proposalId: result.proposalId,
        expectedHash: result.hash,
        expectedRevision: Number(row?.revision),
        expectedPolicyGeneration: Number(row?.policy_generation)
      }
    }
  }

  it('consumes the approval but writes no receipt when the write credential is missing', async () => {
    const { service, push } = await proposedPush()

    const result = await service.approvePush(
      { scope: SCOPE, ...push },
      new AbortController().signal
    )

    expect(result).toEqual({ ok: false, reason: 'no-credential' })
    expect(fx.rows('SELECT state FROM receipts WHERE proposal_id = ?', push.proposalId)).toEqual([])
    const [proposal] = fx.rows('SELECT status FROM proposals WHERE id = ?', push.proposalId)
    expect(proposal?.status).toBe('consumed')
  })

  it('refuses before consuming the approval when it cannot prepare a private work directory', async () => {
    const { service, push } = await proposedPush()
    writeFileSync(join(fx.root, 'forge-inbox-push-work'), 'not a directory')

    const result = await service.approvePush(
      { scope: SCOPE, ...push },
      new AbortController().signal
    )

    expect(result).toEqual({ ok: false, reason: 'workspace-failed' })
    const [proposal] = fx.rows('SELECT status FROM proposals WHERE id = ?', push.proposalId)
    expect(proposal?.status).toBe('pending')
  })

  it('refuses an unknown proposal without any GitLab request', async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    servePushBase()
    const service = fx.service()
    await service.start()

    const result = await service.approvePush(
      {
        scope: SCOPE,
        proposalId: 999,
        expectedHash: 'f'.repeat(64),
        expectedRevision: 1,
        expectedPolicyGeneration: 0
      },
      new AbortController().signal
    )

    expect(result).toEqual({ ok: false, reason: 'not-found' })
    expect(fx.gitlab.requests).toEqual([])
  })
})

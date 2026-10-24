import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createForgeGitBlob } from './forge-inbox-git-objects'
import { SHA_A } from './forge-inbox-gitlab-fake-server'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { createForgePatchProposal } from './forge-inbox-patch-proposal'
import { sha256OfContent, type ForgePatchOperation } from './forge-inbox-patch-draft'
import { ForgeInboxOwnerMismatchError } from './forge-inbox-owner-errors'
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

describe('forge inbox patch approval through the owner service', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  async function seedPatch(): Promise<{
    scope: { instanceId: string }
    proposalId: number
    expectedHash: string
    expectedRevision: number
    expectedPolicyGeneration: number
  }> {
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
          draft: { target: TARGET, baseSha: SHA_A, branch: 'main', operations: OPERATIONS }
        }
      )
      if (!created.ok) {
        throw new Error(`unexpected refusal ${created.reason}`)
      }
      return {
        scope: SCOPE,
        proposalId: created.proposal.id,
        expectedHash: created.hash,
        expectedRevision: created.proposal.revision,
        expectedPolicyGeneration: created.proposal.policyGeneration
      }
    } finally {
      ledger.close()
    }
  }

  function servePatchBase(): void {
    fx.gitlab.state.override = (path) => {
      if (path === '/repository/branches/main') {
        return json({ name: 'main', commit: { id: SHA_A } })
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
      if (path === '/repository/files/src%2Fa.ts/raw') {
        return new Response('old\n', { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return null
    }
  }

  it('approves the displayed patch and builds it in the private host directory', async () => {
    const patch = await seedPatch()
    servePatchBase()
    const service = fx.service()
    await service.start()

    const result = await service.approvePatch(patch, new AbortController().signal)

    if (!result.ok) {
      throw new Error(`unexpected result ${JSON.stringify(result)}`)
    }
    expect(result.written).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.removed).toEqual([])
    expect(result).not.toHaveProperty('directory')
    expect(fx.gitlab.requests).toEqual(
      expect.arrayContaining([
        '/repository/branches/main',
        '/repository/tree',
        '/repository/files/src%2Fa.ts/raw'
      ])
    )
    const work = join(fx.root, 'forge-inbox-patch-work')
    expect(existsSync(work)).toBe(true)
    const directory = readdirSync(work).at(0)
    if (!directory) {
      throw new Error('no tree was built')
    }
    expect(readFileSync(join(work, directory, 'src/a.ts'), 'utf8')).toBe('new\n')
    expect(readFileSync(join(work, directory, 'src/b.ts'), 'utf8')).toBe('b\n')
    const [receipt] = fx.rows('SELECT state FROM receipts')
    expect(receipt?.state).toBe('applied')
  })

  it('refuses before consuming the approval when it cannot prepare a private work directory', async () => {
    const patch = await seedPatch()
    writeFileSync(join(fx.root, 'forge-inbox-patch-work'), 'not a directory')
    const service = fx.service()
    await service.start()

    const result = await service.approvePatch(patch, new AbortController().signal)

    expect(result).toEqual({ ok: false, reason: 'write-failed' })
    expect(fx.gitlab.requests).toEqual([])
    const [proposal] = fx.rows('SELECT status FROM proposals WHERE id = ?', patch.proposalId)
    expect(proposal?.status).toBe('pending')
  })

  it('refuses an unknown proposal without any GitLab request', async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    const service = fx.service()
    await service.start()

    const result = await service.approvePatch(
      {
        scope: SCOPE,
        proposalId: 999,
        expectedHash: 'f'.repeat(64),
        expectedRevision: 0,
        expectedPolicyGeneration: 0
      },
      new AbortController().signal
    )

    expect(result).toEqual({ ok: false, reason: 'not-found' })
    expect(fx.gitlab.requests).toEqual([])
  })

  it('refuses a caller that names another owner', async () => {
    const patch = await seedPatch()
    const service = fx.service()
    await service.start()

    await expect(
      service.approvePatch(patch, new AbortController().signal, 'other-owner')
    ).rejects.toBeInstanceOf(ForgeInboxOwnerMismatchError)
    expect(fx.gitlab.requests).toEqual([])
  })
})

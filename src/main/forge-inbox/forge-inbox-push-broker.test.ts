import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitlabTreeEntry } from './forge-inbox-gitlab-api-schemas'
import type { ForgePushBaseReader } from './forge-inbox-gitlab-push-base'
import {
  approveForgePush,
  buildForgePushPlan,
  type ForgePushPlan
} from './forge-inbox-push-proposal'
import {
  buildForgePushArgs,
  pushForgeProposal,
  type ForgePushRemote
} from './forge-inbox-push-broker'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgePatchDraft } from './forge-inbox-patch-draft'
import {
  buildForgePatchDraft,
  hashForgePatchDraft,
  sha256OfContent
} from './forge-inbox-patch-draft'
import {
  createWebhookHarness,
  INSTANCE_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const TARGET = { instanceId: INSTANCE_ID, projectId: '42' }
const FIRST = '61f87cf496fbb2f460a4f0dce1d72c2499f3843c'
const BASE = '1acc2b8961f7c026e0c2aa13025dacb41174812a'
const TREE = '37be64009ef66e880e17a5e96449ee55cbfd7d48'
const COMMIT = '6126943f0d895ead8e2512144075875788a87115'
const HELLO = 'ce013625030ba8dba906f756967f9e9ca394464a'
const IDENTITY = {
  name: 'Orca',
  email: 'orca@example.com',
  timeSeconds: 1700000000,
  timezone: '+0000'
}

const ENTRIES: GitlabTreeEntry[] = [
  { id: HELLO, name: 'a.txt', type: 'blob', path: 'a.txt', mode: '100644' }
]

function baseCommit(overrides: Record<string, unknown> = {}) {
  return {
    id: BASE,
    parent_ids: [FIRST],
    author_name: 'Orca',
    author_email: 'orca@example.com',
    authored_date: '2023-11-14T22:13:19.000+00:00',
    committer_name: 'Orca',
    committer_email: 'orca@example.com',
    committed_date: '2023-11-14T22:13:19.000+00:00',
    message: 'Base two\n',
    ...overrides
  }
}

type PlanInput = Omit<ForgePushPlan, 'kind' | 'commitSha'>
type PatchSource = { proposalId: number; hash: string }

function planInput(patch: PatchSource, overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    patch,
    target: TARGET,
    branch: 'main',
    expectedHeadSha: BASE,
    treeSha: TREE,
    commit: { author: IDENTITY, committer: IDENTITY, message: 'Forge change\n' },
    ...overrides
  }
}

function draftOf(operations: Parameters<typeof buildForgePatchDraft>[0]['operations']) {
  const built = buildForgePatchDraft({
    target: TARGET,
    baseSha: BASE,
    branch: 'main',
    operations
  })
  if (!built.ok) {
    throw new Error(`draft rejected: ${built.reason}`)
  }
  return built.draft
}

function updateHelloToWorld(): ForgePatchDraft {
  return draftOf([
    {
      op: 'update',
      path: 'a.txt',
      baseSha256: sha256OfContent('hello\n'),
      content: 'world\n',
      resultSha256: sha256OfContent('world\n')
    }
  ])
}

describe('forge push broker', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let root: string
  let remote: string
  let home: string
  let emptyConfig: string

  function git(args: string[], cwd?: string) {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_AUTHOR_NAME: 'Orca',
        GIT_AUTHOR_EMAIL: 'orca@example.com',
        GIT_AUTHOR_DATE: '1699999999 +0000',
        GIT_COMMITTER_NAME: 'Orca',
        GIT_COMMITTER_EMAIL: 'orca@example.com',
        GIT_COMMITTER_DATE: '1699999999 +0000'
      }
    })
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
    }
    return result.stdout.trim()
  }

  function remoteHead(): string {
    return git(['--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/main'])
  }

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger, webhookConfig([webhookInstance()]))
    root = mkdtempSync(join(tmpdir(), 'forge-push-broker-'))
    home = join(root, 'home')
    emptyConfig = join(root, 'gitconfig')
    writeFileSync(emptyConfig, '')
    remote = join(root, 'remote.git')
    const work = join(root, 'work')
    git(['init', '--quiet', '--bare', remote], root)
    git(['init', '--quiet', work], root)
    writeFileSync(join(work, 'a.txt'), 'hello\n')
    git(['add', 'a.txt'], work)
    git(['commit', '--quiet', '-m', 'Base'], work)
    git(['commit', '--quiet', '--allow-empty', '-m', 'Base two'], work)
    if (git(['rev-parse', 'HEAD'], work) !== BASE) {
      throw new Error('base commit fixture drifted from its golden id')
    }
    git(['remote', 'add', 'origin', remote], work)
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], work)
  })

  afterEach(() => {
    ledger.close()
    harness.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  function runningRun(): { runId: number; generation: number } {
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
    return { runId: run.id, generation: run.generation }
  }

  /** A push only publishes a patch the owner consumed and the broker applied. */
  function appliedPatch(runId: number, generation: number): PatchSource {
    const draft = updateHelloToWorld()
    const created = ledger.createProposal({
      runId,
      expectedGeneration: generation,
      body: draft
    })
    if (!created.ok) {
      throw new Error(`patch proposal rejected: ${created.reason}`)
    }
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
    ledger.finishReceipt(begun.receipt.id, { state: 'applied' })
    return { proposalId: created.proposal.id, hash: hashForgePatchDraft(draft) }
  }

  function createPush(overrides: Partial<PlanInput> = {}) {
    const run = runningRun()
    const patch = appliedPatch(run.runId, run.generation)
    const created = ledger.createPushProposal({
      scope: SCOPE,
      runId: run.runId,
      plan: planInput(patch, overrides)
    })
    if (!created.ok) {
      throw new Error(`proposal rejected: ${created.reason}`)
    }
    return created
  }

  async function approvedPush(
    options: {
      overrides?: Partial<PlanInput>
      readHead?: () => Promise<
        { ok: true; sha: string } | { ok: false; code: 'network' | 'unauthorized' }
      >
    } = {}
  ): Promise<{ proposalId: number; hash: string }> {
    const created = createPush(options.overrides)
    const approved = await approveForgePush(
      { ledger, readHead: options.readHead ?? (async () => ({ ok: true, sha: BASE })) },
      {
        scope: SCOPE,
        proposalId: created.proposal.id,
        expectedHash: created.hash,
        expectedRevision: created.proposal.revision,
        expectedPolicyGeneration: created.proposal.policyGeneration
      },
      new AbortController().signal
    )
    if (!approved.ok) {
      throw new Error(`approval rejected: ${approved.reason}`)
    }
    return { proposalId: created.proposal.id, hash: created.hash }
  }

  function baseReader(overrides: Partial<ForgePushBaseReader> = {}): ForgePushBaseReader {
    return {
      listRepositoryTree: vi.fn(async () => ({
        ok: true as const,
        complete: true,
        data: ENTRIES
      })),
      getRepositoryCommit: vi.fn(async () => ({
        ok: true as const,
        complete: true,
        data: baseCommit()
      })),
      ...overrides
    }
  }

  /** A config entry the broker must install; the file remote ignores its contents. */
  function remoteAt(url: string): ForgePushRemote {
    return { ok: true, url, config: [['core.autocrlf', 'false']] }
  }

  function pushPath(
    approved: { proposalId: number; hash: string },
    options: {
      reader?: ForgePushBaseReader
      remote?: ForgePushRemote
      signal?: AbortSignal
    } = {}
  ) {
    return pushForgeProposal(
      {
        ledger,
        reader: options.reader ?? baseReader(),
        remote: async () => options.remote ?? remoteAt(remote),
        parentDirectory: root
      },
      { scope: SCOPE, proposalId: approved.proposalId, expectedHash: approved.hash },
      options.signal ?? new AbortController().signal
    )
  }

  it('pushes the approved commit and moves the branch to it', async () => {
    const approved = await approvedPush()

    const result = await pushPath(approved)

    expect(result).toMatchObject({ kind: 'pushed', branch: 'main', commitSha: COMMIT })
    expect(remoteHead()).toBe(COMMIT)
    expect(git(['--git-dir', remote, 'cat-file', '-p', `${COMMIT}^{tree}`])).toContain('a.txt')
  })

  it('refuses a lease that no longer matches the remote branch', async () => {
    const approved = await approvedPush()
    const work = join(root, 'work')
    // Why an ancestor: the new commit would fast-forward over it, so only the literal lease stops it.
    git(['push', '--quiet', '--force', remote, `${FIRST}:refs/heads/main`], work)
    expect(remoteHead()).toBe(FIRST)

    const result = await pushPath(approved)

    expect(result).toEqual({ kind: 'failed', receiptId: expect.any(Number), reason: 'rejected' })
    expect(remoteHead()).toBe(FIRST)
  })

  it('refuses before any git work when the proposal is not approved', async () => {
    const created = createPush()

    const result = await pushPath({ proposalId: created.proposal.id, hash: created.hash })

    expect(result).toEqual({ kind: 'refused', reason: 'not-approved' })
    expect(ledger.getProposalReceipt(created.proposal.id)).toBeNull()
    expect(remoteHead()).toBe(BASE)
  })

  it('refuses a manifest that does not reproduce the approved tree', async () => {
    const approved = await approvedPush({ overrides: { treeSha: 'f'.repeat(40) } })

    const result = await pushPath(approved)

    expect(result).toMatchObject({ kind: 'failed', reason: 'tree-mismatch' })
    expect(remoteHead()).toBe(BASE)
  })

  it('refuses a base whose metadata does not reproduce the approved head', async () => {
    const approved = await approvedPush()

    const result = await pushPath(approved, {
      reader: baseReader({
        getRepositoryCommit: vi.fn(async () => ({
          ok: true as const,
          complete: true,
          data: baseCommit({ message: 'Rewritten\n' })
        }))
      })
    })

    expect(result).toMatchObject({ kind: 'failed', reason: 'base-unverified' })
    expect(remoteHead()).toBe(BASE)
  })

  it('marks the receipt unknown when the remote cannot confirm the outcome', async () => {
    const approved = await approvedPush()

    const result = await pushPath(approved, { remote: remoteAt(join(root, 'missing-remote.git')) })

    expect(result).toEqual({ kind: 'unknown', receiptId: expect.any(Number) })
    expect(remoteHead()).toBe(BASE)
  })

  it('refuses without a receipt when the write credential is missing', async () => {
    const approved = await approvedPush()

    await expect(
      pushPath(approved, { remote: { ok: false, reason: 'no-credential' } })
    ).resolves.toEqual({ kind: 'refused', reason: 'no-credential' })
    await expect(
      pushPath(approved, { remote: { ok: true, url: remote, config: [] } })
    ).resolves.toEqual({ kind: 'refused', reason: 'no-credential' })
    expect(ledger.getProposalReceipt(approved.proposalId)).toBeNull()
    expect(remoteHead()).toBe(BASE)
  })

  it('never runs a second push for the same approval', async () => {
    const approved = await approvedPush()
    await expect(pushPath(approved)).resolves.toMatchObject({ kind: 'pushed' })

    await expect(pushPath(approved)).resolves.toEqual({
      kind: 'refused',
      reason: 'already-pushed'
    })
    expect(remoteHead()).toBe(COMMIT)
  })
})

describe('forge push arguments', () => {
  it('sends one explicit refspec under a literal lease and never a bare force', () => {
    const built = buildForgePushPlan(planInput({ proposalId: 1, hash: 'a'.repeat(64) }))
    if (!built.ok) {
      throw new Error(`plan rejected: ${built.reason}`)
    }

    const args = buildForgePushArgs(
      built.plan,
      '/push/repository.git',
      'https://gitlab.example/a/b.git'
    )

    expect(args).toContain('--no-verify')
    expect(args).toContain(`--force-with-lease=refs/heads/main:${BASE}`)
    expect(args).not.toContain('--force')
    expect(args).not.toContain('+')
    // Everything after `--` is exactly the remote and one refspec, so no extra ref can ride along.
    expect(args.slice(args.indexOf('--') + 1)).toEqual([
      'https://gitlab.example/a/b.git',
      `${COMMIT}:refs/heads/main`
    ])
  })
})

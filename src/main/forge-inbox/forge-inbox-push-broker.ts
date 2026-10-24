import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import type { ForgePushApplyRefusal, ForgePushFailureReason } from '../../shared/forge-push'
import { buildForgePushTree } from './forge-inbox-git-push-tree'
import {
  prepareWorkspace,
  sealedGitEnv,
  withRemoteConfig,
  writeLooseObject
} from './forge-inbox-git-sealed-workspace'
import { readForgePushBase, type ForgePushBaseReader } from './forge-inbox-gitlab-push-base'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { hashForgePatchDraft, parseForgePatchDraft } from './forge-inbox-patch-draft'
import {
  createForgePushCommit,
  hashForgePushPlan,
  parseForgePushPlan,
  type ForgePushPlan
} from './forge-inbox-push-proposal'

const GIT_TIMEOUT_MS = 60_000
const OUTPUT_MAX_BYTES = 64 * 1024

/** Resolved before any receipt exists: a missing credential refuses instead of pushing unauth. */
export type ForgePushRemote =
  | { ok: true; url: string; config: readonly (readonly [string, string])[] }
  | { ok: false; reason: 'project-unavailable' | 'no-credential' }

export type ForgePushResult =
  | { kind: 'pushed'; receiptId: number; branch: string; commitSha: string }
  | { kind: 'failed'; receiptId: number; reason: ForgePushFailureReason }
  | { kind: 'unknown'; receiptId: number }
  | { kind: 'refused'; reason: ForgePushApplyRefusal }

/**
 * One explicit refspec and a literal lease: the update is conditional on the exact head the
 * approval saw, and no other ref (tag, remote, follow) can ride along.
 */
export function buildForgePushArgs(
  plan: ForgePushPlan,
  gitDirectory: string,
  remoteUrl: string
): string[] {
  return [
    '--git-dir',
    gitDirectory,
    'push',
    '--porcelain',
    '--no-verify',
    `--force-with-lease=refs/heads/${plan.branch}:${plan.expectedHeadSha}`,
    '--',
    remoteUrl,
    `${plan.commitSha}:refs/heads/${plan.branch}`
  ]
}

function firstRemoteOid(stdout: string): string | null {
  const line = stdout.split('\n').find((value) => value.trim() !== '')
  const oid = line?.split('\t')[0]?.trim()
  return oid && /^[0-9a-f]{40,64}$/.test(oid) ? oid : null
}

/**
 * Commits an approved push entirely inside a throwaway bare repository. The base commit is
 * reconstructed from restricted API reads and must hash to the approved head, the new tree must
 * reproduce the approved tree id, and the branch is updated only through a literal lease. The
 * receipt is written before the first object and nothing is ever replayed blindly.
 */
export async function pushForgeProposal(
  deps: {
    ledger: Pick<ForgeInboxLedger, 'getProposal' | 'getItem' | 'beginReceipt' | 'finishReceipt'>
    reader: ForgePushBaseReader
    /** Resolves the GitLab URL and its auth config; runs before the receipt so it can refuse. */
    remote: (plan: ForgePushPlan, signal: AbortSignal) => Promise<ForgePushRemote>
    parentDirectory: string
  },
  input: { scope: ForgeInstanceScope; proposalId: number; expectedHash: string },
  signal: AbortSignal
): Promise<ForgePushResult> {
  const proposal = deps.ledger.getProposal(input.proposalId)
  if (!proposal) {
    return { kind: 'refused', reason: 'not-found' }
  }
  const plan = parseForgePushPlan(proposal.body)
  if (!plan) {
    return { kind: 'refused', reason: 'not-a-push' }
  }
  if (hashForgePushPlan(plan) !== input.expectedHash) {
    return { kind: 'refused', reason: 'plan-mismatch' }
  }
  if (!deps.ledger.getItem(input.scope, proposal.itemId)) {
    return { kind: 'refused', reason: 'not-found' }
  }
  const patch = deps.ledger.getProposal(plan.patch.proposalId)
  const draft = patch ? parseForgePatchDraft(patch.body) : null
  if (
    draft === null ||
    hashForgePatchDraft(draft) !== plan.patch.hash ||
    draft.baseSha !== plan.expectedHeadSha ||
    draft.branch !== plan.branch ||
    draft.target.instanceId !== plan.target.instanceId ||
    draft.target.projectId !== plan.target.projectId
  ) {
    return { kind: 'refused', reason: 'plan-mismatch' }
  }

  let workspace: string | null = null
  try {
    workspace = mkdtempSync(join(deps.parentDirectory, 'forge-push-'))
    prepareWorkspace(workspace)
  } catch {
    if (workspace !== null) {
      rmSync(workspace, { recursive: true, force: true })
    }
    return { kind: 'refused', reason: 'workspace-failed' }
  }
  try {
    const remote = await deps.remote(plan, signal)
    if (!remote.ok) {
      return { kind: 'refused', reason: remote.reason }
    }
    const environment = withRemoteConfig(sealedGitEnv(workspace), remote.config)
    if (environment === null) {
      return { kind: 'refused', reason: 'no-credential' }
    }
    return await pushWithReceipt(
      deps,
      { proposalId: proposal.id, plan, draft },
      workspace,
      remote.url,
      environment,
      signal
    )
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

async function pushWithReceipt(
  deps: {
    ledger: Pick<ForgeInboxLedger, 'getItem' | 'beginReceipt' | 'finishReceipt'>
    reader: ForgePushBaseReader
  },
  resolved: {
    proposalId: number
    plan: ForgePushPlan
    draft: NonNullable<ReturnType<typeof parseForgePatchDraft>>
  },
  workspace: string,
  remoteUrl: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<ForgePushResult> {
  const { proposalId, plan, draft } = resolved
  const begun = deps.ledger.beginReceipt({ proposalId })
  if (!begun.receipt) {
    return { kind: 'refused', reason: 'not-approved' }
  }
  if (!begun.started) {
    return { kind: 'refused', reason: 'already-pushed' }
  }
  const receiptId = begun.receipt.id
  const fail = (reason: ForgePushFailureReason): ForgePushResult => {
    deps.ledger.finishReceipt(receiptId, { state: 'failed', result: { reason } })
    return { kind: 'failed', receiptId, reason }
  }

  const base = await readForgePushBase(
    { reader: deps.reader, expectedHeadSha: plan.expectedHeadSha },
    signal
  )
  if (!base.ok) {
    return fail(base.reason)
  }
  const tree = buildForgePushTree({
    entries: base.base.entries.map((entry) => ({
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      id: entry.id
    })),
    draft
  })
  if (!tree.ok) {
    return fail('tree-invalid')
  }
  if (tree.rootTree !== plan.treeSha) {
    return fail('tree-mismatch')
  }
  const commit = createForgePushCommit(plan)
  if (commit === null) {
    return fail('internal')
  }

  const gitDirectory = join(workspace, 'repository.git')
  const probe = await runProcess(
    {
      program: 'git',
      args: ['config', '--get', 'core.hooksPath'],
      cwd: workspace,
      env: environment,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: OUTPUT_MAX_BYTES
    },
    'tail'
  )
  // Why: GIT_CONFIG_COUNT only exists from git 2.31; older git would silently run unsealed.
  if (probe.code !== 0 || probe.stdout.trim() !== environment.GIT_CONFIG_VALUE_0) {
    return fail('git-unavailable')
  }
  const init = await runProcess(
    {
      program: 'git',
      args: [
        'init',
        '--bare',
        '--quiet',
        `--template=${join(workspace, 'templates')}`,
        gitDirectory
      ],
      cwd: workspace,
      env: environment,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: OUTPUT_MAX_BYTES
    },
    'tail'
  )
  if (init.code !== 0) {
    return fail('git-unavailable')
  }
  writeLooseObject(gitDirectory, base.base.commit)
  for (const object of tree.objects) {
    writeLooseObject(gitDirectory, object)
  }
  writeLooseObject(gitDirectory, commit)
  writeFileSync(join(gitDirectory, 'shallow'), `${plan.expectedHeadSha}\n`, { mode: 0o600 })

  const push = await runProcess(
    {
      program: 'git',
      args: buildForgePushArgs(plan, gitDirectory, remoteUrl),
      cwd: workspace,
      env: environment,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: OUTPUT_MAX_BYTES,
      signal
    },
    'tail'
  )
  if (push.code === 0 && !push.timedOut) {
    return applied(deps, receiptId, plan)
  }
  const observed = await runProcess(
    {
      program: 'git',
      args: [
        '--git-dir',
        gitDirectory,
        'ls-remote',
        '--heads',
        '--',
        remoteUrl,
        `refs/heads/${plan.branch}`
      ],
      cwd: workspace,
      env: environment,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: OUTPUT_MAX_BYTES
    },
    'tail'
  )
  const remoteHead = observed.code === 0 ? firstRemoteOid(observed.stdout) : null
  if (remoteHead === plan.commitSha) {
    return applied(deps, receiptId, plan)
  }
  if (remoteHead !== null) {
    return fail('rejected')
  }
  deps.ledger.finishReceipt(receiptId, { state: 'unknown', result: { reason: 'unconfirmed' } })
  return { kind: 'unknown', receiptId }
}

function applied(
  deps: { ledger: Pick<ForgeInboxLedger, 'finishReceipt'> },
  receiptId: number,
  plan: ForgePushPlan
): ForgePushResult {
  deps.ledger.finishReceipt(receiptId, {
    state: 'applied',
    result: {
      branch: plan.branch,
      expectedHeadSha: plan.expectedHeadSha,
      treeSha: plan.treeSha,
      commitSha: plan.commitSha
    }
  })
  return { kind: 'pushed', receiptId, branch: plan.branch, commitSha: plan.commitSha }
}

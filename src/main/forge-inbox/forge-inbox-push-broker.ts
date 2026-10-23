import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { runProcess } from '@orca/process-host'
import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import type { ForgeGitObject } from './forge-inbox-git-objects'
import { buildForgePushTree } from './forge-inbox-git-push-tree'
import { readForgePushBase, type ForgePushBaseReader } from './forge-inbox-gitlab-push-base'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgePatchDraft } from './forge-inbox-patch-draft'
import {
  createForgePushCommit,
  hashForgePushPlan,
  parseForgePushPlan,
  type ForgePushPlan
} from './forge-inbox-push-proposal'

const GIT_TIMEOUT_MS = 60_000
const OUTPUT_MAX_BYTES = 64 * 1024
const INHERITED_ENV_KEYS = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR'
] as const

export type ForgePushRefusal =
  | 'not-found'
  | 'not-a-push'
  | 'plan-mismatch'
  | 'not-approved'
  | 'already-pushed'

export type ForgePushFailure =
  | 'base-unavailable'
  | 'base-unsupported'
  | 'base-unverified'
  | 'tree-invalid'
  | 'tree-mismatch'
  | 'workspace-failed'
  | 'git-unavailable'
  | 'rejected'
  | 'internal'

export type ForgePushResult =
  | { kind: 'pushed'; receiptId: number; branch: string; commitSha: string }
  | { kind: 'failed'; receiptId: number; reason: ForgePushFailure }
  | { kind: 'unknown'; receiptId: number }
  | { kind: 'refused'; reason: ForgePushRefusal }

/**
 * A sealed environment: no user/system git config, no templates, no hooks, no prompt, and a
 * private HOME, so nothing from the developer's machine can change what this push does.
 */
function sealedGitEnv(workspace: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  const home = join(workspace, 'home')
  env.HOME = home
  env.USERPROFILE = home
  env.XDG_CONFIG_HOME = home
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = join(workspace, 'gitconfig')
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ASKPASS = ''
  env.SSH_ASKPASS = ''
  env.GCM_INTERACTIVE = 'never'
  env.GIT_ATTR_NOSYSTEM = '1'
  env.GIT_CONFIG_COUNT = '1'
  env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
  env.GIT_CONFIG_VALUE_0 = join(workspace, 'hooks')
  return env
}

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

function looseObjectBytes(object: ForgeGitObject): Buffer {
  const header = Buffer.from(`${object.type} ${object.content.length}\u0000`, 'utf8')
  return deflateSync(Buffer.concat([header, object.content]))
}

function writeLooseObject(gitDirectory: string, object: ForgeGitObject): void {
  const directory = join(gitDirectory, 'objects', object.oid.slice(0, 2))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(directory, object.oid.slice(2)), looseObjectBytes(object), { mode: 0o600 })
}

function prepareWorkspace(workspace: string): void {
  mkdirSync(join(workspace, 'home'), { recursive: true, mode: 0o700 })
  mkdirSync(join(workspace, 'hooks'), { recursive: true, mode: 0o700 })
  const emptyTemplate = join(workspace, 'templates')
  mkdirSync(emptyTemplate, { recursive: true, mode: 0o700 })
  writeFileSync(join(workspace, 'gitconfig'), '', { mode: 0o600 })
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
    /** Where the approved manifest lives; the broker refuses anything that reproduces another tree. */
    draft: (plan: ForgePushPlan) => ForgePatchDraft | null
    remoteUrl: string
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
  const begun = deps.ledger.beginReceipt({ proposalId: proposal.id })
  if (!begun.receipt) {
    return { kind: 'refused', reason: 'not-approved' }
  }
  if (!begun.started) {
    return { kind: 'refused', reason: 'already-pushed' }
  }
  const receiptId = begun.receipt.id
  const fail = (reason: ForgePushFailure): ForgePushResult => {
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
  const draft = deps.draft(plan)
  if (
    draft === null ||
    draft.baseSha !== plan.expectedHeadSha ||
    draft.branch !== plan.branch ||
    draft.target.instanceId !== plan.target.instanceId ||
    draft.target.projectId !== plan.target.projectId
  ) {
    return fail('tree-mismatch')
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

  let workspace: string
  try {
    workspace = mkdtempSync(join(deps.parentDirectory, 'forge-push-'))
    prepareWorkspace(workspace)
  } catch {
    return fail('workspace-failed')
  }
  const environment = sealedGitEnv(workspace)
  const gitDirectory = join(workspace, 'repository.git')
  try {
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
        args: buildForgePushArgs(plan, gitDirectory, deps.remoteUrl),
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
          deps.remoteUrl,
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
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
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

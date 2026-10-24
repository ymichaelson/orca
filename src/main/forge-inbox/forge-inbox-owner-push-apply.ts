import { mkdirSync } from 'node:fs'
import type {
  ForgePushApplyRefusal,
  ForgePushApprovalRefusal,
  ForgePushFailureReason
} from '../../shared/forge-push'
import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import type { MainHttpClient } from '../network/http-client'
import { ForgeCredentialUnavailableError } from './forge-inbox-credentials'
import type { GitlabApiReader } from './forge-inbox-gitlab-api-client'
import { createForgeOwnerGitlabReader } from './forge-inbox-gitlab-owner-reader'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { pushForgeProposal, type ForgePushRemote } from './forge-inbox-push-broker'
import { approveForgePush, parseForgePushPlan } from './forge-inbox-push-proposal'

export type ForgePushApplyInput = {
  scope: ForgeInstanceScope
  proposalId: number
  expectedHash: string
  expectedRevision: number
  expectedPolicyGeneration: number
}

export type ForgePushApplyResult =
  | { ok: true; receiptId: number; branch: string; commitSha: string }
  | {
      ok: false
      reason:
        | ForgePushApprovalRefusal
        | ForgePushApplyRefusal
        | ForgePushFailureReason
        | 'unconfirmed'
      receiptId?: number
    }

export type ForgeOwnerPushApply = (
  input: ForgePushApplyInput,
  signal: AbortSignal
) => Promise<ForgePushApplyResult>

/**
 * Approval re-reads the branch head and consumes exactly one pending proposal; the push itself
 * then runs against a sealed bare repository with the owner's api-write credential. A credential
 * or project that cannot be resolved refuses before any receipt exists.
 */
export function createForgeOwnerPushApply(deps: {
  ledger: ForgeInboxLedger
  http: Pick<MainHttpClient, 'fetch'>
  signal: AbortSignal
  parentDirectory: string
}): ForgeOwnerPushApply {
  return async (input, signal) => {
    const combined = AbortSignal.any([deps.signal, signal])
    if (!ensurePrivateDirectory(deps.parentDirectory)) {
      return { ok: false, reason: 'workspace-failed' }
    }
    const approval = await approveForgePush(
      {
        ledger: deps.ledger,
        readHead: async (request, headSignal) => {
          const owner = createForgeOwnerGitlabReader(
            { ledger: deps.ledger, http: deps.http, signal: headSignal },
            request
          )
          if (!owner.ok) {
            return { ok: false, code: owner.reason }
          }
          const head = await owner.reader.getRepositoryBranchHead(request.branch)
          return head.ok ? { ok: true, sha: head.data.sha } : { ok: false, code: head.code }
        }
      },
      input,
      combined
    )
    if (!approval.ok) {
      return approval
    }
    const plan = parseForgePushPlan(approval.proposal.body)
    if (!plan) {
      return { ok: false, reason: 'not-a-push' }
    }
    const owner = createForgeOwnerGitlabReader(
      { ledger: deps.ledger, http: deps.http, signal: combined },
      plan.target
    )
    if (!owner.ok) {
      return { ok: false, reason: 'project-unavailable' }
    }
    const pushed = await pushForgeProposal(
      {
        ledger: deps.ledger,
        reader: owner.reader,
        remote: (): Promise<ForgePushRemote> =>
          resolveRemote(deps.ledger, owner.reader, plan.target.instanceId),
        parentDirectory: deps.parentDirectory
      },
      { scope: input.scope, proposalId: input.proposalId, expectedHash: input.expectedHash },
      combined
    )
    if (pushed.kind === 'pushed') {
      return {
        ok: true,
        receiptId: pushed.receiptId,
        branch: pushed.branch,
        commitSha: pushed.commitSha
      }
    }
    if (pushed.kind === 'refused') {
      return { ok: false, reason: pushed.reason }
    }
    return pushed.kind === 'failed'
      ? { ok: false, reason: pushed.reason, receiptId: pushed.receiptId }
      : { ok: false, reason: 'unconfirmed', receiptId: pushed.receiptId }
  }
}

/**
 * The write credential is only ever composed into the sealed Git config env, never into the URL,
 * argv or a log line.
 */
async function resolveRemote(
  ledger: ForgeInboxLedger,
  reader: Pick<GitlabApiReader, 'getProjectRepository'>,
  instanceId: string
): Promise<ForgePushRemote> {
  const repository = await reader.getProjectRepository()
  if (!repository.ok) {
    return { ok: false, reason: 'project-unavailable' }
  }
  const token = readWriteToken(ledger, instanceId)
  if (token === null) {
    return { ok: false, reason: 'no-credential' }
  }
  const url = repository.data.httpUrl
  const header = `Authorization: Basic ${Buffer.from(`oauth2:${token}`, 'utf8').toString('base64')}`
  return { ok: true, url, config: [[`http.${url}.extraheader`, header]] }
}

function readWriteToken(ledger: ForgeInboxLedger, instanceId: string): string | null {
  try {
    return ledger.readSecret(instanceId, 'api-write')?.secret ?? null
  } catch (error) {
    if (error instanceof ForgeCredentialUnavailableError) {
      return null
    }
    throw error
  }
}

function ensurePrivateDirectory(directory: string): boolean {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return true
  } catch {
    return false
  }
}

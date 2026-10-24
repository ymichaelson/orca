import { mkdirSync } from 'node:fs'
import type { ForgeInboxPatchApplyOutcome } from '../../shared/forge-inbox-rpc-types'
import type { MainHttpClient } from '../network/http-client'
import { approveAndApplyForgePatch, type ForgePatchApplyInput } from './forge-inbox-patch-apply'
import type { ForgePatchDraft } from './forge-inbox-patch-draft'
import { createGitlabPatchSource } from './forge-inbox-gitlab-patch-source'
import { createForgeOwnerGitlabReader } from './forge-inbox-gitlab-owner-reader'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgePatchSource } from './forge-inbox-patch-tree'

export type ForgeOwnerPatchApply = (
  input: ForgePatchApplyInput,
  signal: AbortSignal
) => Promise<ForgeInboxPatchApplyOutcome>

const unavailableSource: ForgePatchSource = {
  readPath: async () => ({ kind: 'unavailable' })
}

/**
 * Binds approval and apply to the owner's api-read credential. Base reads are pinned to the
 * approved commit, and the private work directory never leaves this host.
 */
export function createForgeOwnerPatchApply(deps: {
  ledger: ForgeInboxLedger
  http: Pick<MainHttpClient, 'fetch'>
  signal: AbortSignal
  parentDirectory: string
}): ForgeOwnerPatchApply {
  return async (input, signal) => {
    if (!ensurePrivateDirectory(deps.parentDirectory)) {
      return { ok: false, reason: 'write-failed' }
    }
    const combined = AbortSignal.any([deps.signal, signal])
    return approveAndApplyForgePatch(
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
        },
        source: (draft: ForgePatchDraft) => {
          const owner = createForgeOwnerGitlabReader(
            { ledger: deps.ledger, http: deps.http, signal: combined },
            draft.target
          )
          return owner.ok
            ? createGitlabPatchSource({ reader: owner.reader, ref: draft.baseSha })
            : unavailableSource
        },
        parentDirectory: deps.parentDirectory
      },
      input,
      combined
    )
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

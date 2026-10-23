import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import type { MainHttpClient } from '../network/http-client'
import type { ForgeCommentHeadReader } from './forge-inbox-comment-proposal'
import { publishForgeComment, type ForgeCommentPublishResult } from './forge-inbox-comment-publish'
import { ForgeCredentialUnavailableError } from './forge-inbox-credentials'
import { createGitlabCommentPublisher } from './forge-inbox-gitlab-comment-publish'
import type { ForgeInboxLedger } from './forge-inbox-ledger'

export type ForgeCommentBroker = {
  publish(
    input: { scope: ForgeInstanceScope; proposalId: number; expectedHash: string },
    signal: AbortSignal
  ): Promise<ForgeCommentPublishResult>
  /** Reads the merge request head the approval is bound to, with the read credential only. */
  readHead: ForgeCommentHeadReader
}

/**
 * The production comment broker: the last host-side hop between an approved proposal and GitLab.
 * Credentials and the instance origin come from the ledger at publish time, so a rotated or
 * revoked credential applies here without handing any caller a token or a URL.
 */
export function createForgeCommentBroker(deps: {
  ledger: ForgeInboxLedger
  http: Pick<MainHttpClient, 'fetch'>
}): ForgeCommentBroker {
  const { ledger, http } = deps
  // Built per call: a rotated credential or edited instance applies to the next approval, not the next restart.
  function ports() {
    const { configRevision, config } = ledger.getConfig()
    return createGitlabCommentPublisher({
      http,
      readWriteToken: (instanceId) => readSecret(ledger, instanceId, 'api-write'),
      readReadToken: (instanceId) => readSecret(ledger, instanceId, 'api-read'),
      readConfigRevision: () => ledger.getConfig().configRevision,
      expectedConfigRevision: configRevision,
      resolveInstanceBaseUrl: (instanceId) =>
        config.instances.find((candidate) => candidate.id === instanceId)?.baseUrl ?? null
    })
  }
  return {
    publish(input, signal) {
      const reader = ports()
      return publishForgeComment(
        { ledger, post: reader.post, findNotes: reader.findNotes },
        input,
        signal
      )
    },
    readHead(target, signal) {
      return ports().readHead(target, signal)
    }
  }
}

/** An unreadable envelope is simply an absent credential here; anything else is a real fault. */
function readSecret(
  ledger: ForgeInboxLedger,
  instanceId: string,
  kind: 'api-read' | 'api-write'
): string | null {
  try {
    return ledger.readSecret(instanceId, kind)?.secret ?? null
  } catch (error) {
    if (error instanceof ForgeCredentialUnavailableError) {
      return null
    }
    throw error
  }
}

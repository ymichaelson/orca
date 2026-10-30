import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import type { MainHttpClient } from '../network/http-client'
import type { GitlabProjectApiScope } from '../gitlab/gitlab-project-api'
import type { ForgeCommentTarget } from './forge-inbox-comment-draft'
import type { ForgeCommentHeadReader } from './forge-inbox-comment-proposal'
import { publishForgeComment, type ForgeCommentPublishResult } from './forge-inbox-comment-publish'
import { bindingCommentScopeForTarget } from './forge-inbox-comment-target-binding'
import { ForgeCredentialUnavailableError } from './forge-inbox-credentials'
import { createGitlabBindingCommentPorts } from './forge-inbox-gitlab-binding-comment'
import { createGitlabCommentPublisher } from './forge-inbox-gitlab-comment-publish'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { BINDING_INSTANCE_PREFIX } from './forge-inbox-project-binding'

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
  /** Overrides glab for tests; production runs the host CLI so no token is ever stored here. */
  glabExec?: GitlabProjectApiScope['exec']
}): ForgeCommentBroker {
  const { ledger, http, glabExec } = deps
  // Built per call: a rotated credential or edited instance applies to the next approval, not the next restart.
  function instancePorts() {
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
  // Why: a binding item has no instance credential; its binding owns the destination and glab the token.
  function ports(target: ForgeCommentTarget): ReturnType<typeof instancePorts> {
    const scope = bindingCommentScopeForTarget(ledger.ledgerContext(), target)
    if (scope === null) {
      // Why: a binding target without a unique binding must refuse, never borrow an instance credential.
      return target.instanceId.startsWith(BINDING_INSTANCE_PREFIX)
        ? REFUSING_PORTS
        : instancePorts()
    }
    return createGitlabBindingCommentPorts(
      glabExec === undefined ? scope : { ...scope, exec: glabExec }
    )
  }
  return {
    publish(input, signal) {
      return publishForgeComment(
        {
          ledger,
          post: (request, postSignal) => ports(request.target).post(request, postSignal),
          findNotes: (request, findSignal) => ports(request.target).findNotes(request, findSignal)
        },
        input,
        signal
      )
    },
    readHead(target, signal) {
      return ports(target).readHead(target, signal)
    }
  }
}

const REFUSING_PORTS: ReturnType<typeof createGitlabCommentPublisher> = {
  post: async () => ({ ok: false, code: 'no-credential', mayHaveLanded: false }),
  readHead: async () => ({ ok: false, code: 'no-credential' }),
  findNotes: async () => ({ ok: false, code: 'no-credential' })
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

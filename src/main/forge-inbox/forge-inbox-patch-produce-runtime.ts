import type { MainHttpClient } from '../network/http-client'
import {
  forgeAnalysisSessionHost,
  type ForgeInboxAnalysisRuntimeBinding
} from './forge-inbox-analysis-runtime'
import { createForgeOwnerGitlabReader } from './forge-inbox-gitlab-owner-reader'
import { createForgeInboxPatchProducer } from './forge-inbox-patch-produce'
import type { ForgeInboxOwnerServiceOptions } from './forge-inbox-owner-service'

/** What a host shell must supply: the chat host it already installs for analysis and Discuss. */
export type ForgeInboxPatchProduceRuntimeBinding = Pick<
  ForgeInboxAnalysisRuntimeBinding,
  'ensureStructuredAgentSessionHost'
>

/**
 * The production patch producer. The reader is opened per request for the item's own instance and
 * project, and a record this host cannot read refuses the turn rather than faking a proposal.
 */
export function forgeInboxPatchProducerForRuntime(input: {
  runtime: ForgeInboxPatchProduceRuntimeBinding
  http: Pick<MainHttpClient, 'fetch'>
}): NonNullable<ForgeInboxOwnerServiceOptions['proposePatch']> {
  return (ledger) =>
    createForgeInboxPatchProducer({
      ledger,
      openReader: async (target, signal) => {
        const made = createForgeOwnerGitlabReader({ ledger, http: input.http, signal }, target)
        return made.ok ? made.reader : null
      },
      ensureHost: () => forgeAnalysisSessionHost(input.runtime),
      readRecord: async (sessionId) =>
        (await forgeAnalysisSessionHost(input.runtime)).sessionRecord(sessionId) ?? null
    })
}

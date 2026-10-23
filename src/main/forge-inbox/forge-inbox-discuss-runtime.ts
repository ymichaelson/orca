import {
  forgeAnalysisSessionHost,
  type ForgeInboxAnalysisRuntimeBinding
} from './forge-inbox-analysis-runtime'
import { createForgeInboxDiscuss } from './forge-inbox-discuss'
import type { ForgeInboxOwnerServiceOptions } from './forge-inbox-owner-service'

/** What a host shell must supply: its chat host, installed lazily the first time a record is read. */
export type ForgeInboxDiscussRuntimeBinding = Pick<
  ForgeInboxAnalysisRuntimeBinding,
  'ensureStructuredAgentSessionHost'
>

/**
 * The production Discuss a host injects. A record this runtime cannot read is simply unknown here,
 * so an analysis that ran elsewhere is refused instead of being resumed in some ordinary chat.
 */
export function forgeInboxDiscussForRuntime(
  runtime: ForgeInboxDiscussRuntimeBinding
): NonNullable<ForgeInboxOwnerServiceOptions['discuss']> {
  return (ledger) =>
    createForgeInboxDiscuss({
      ledger,
      ensureHost: () => forgeAnalysisSessionHost(runtime),
      readRecord: async (sessionId) =>
        (await forgeAnalysisSessionHost(runtime)).sessionRecord(sessionId) ?? null
    })
}

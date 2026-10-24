import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import type { MainHttpClient } from '../network/http-client'
import type { ForgeAnalysisTurn } from './forge-inbox-analysis-runner'
import { createForgeAnalysisRunner } from './forge-inbox-analysis-runner'
import { createForgeOwnerGitlabReader } from './forge-inbox-gitlab-owner-reader'
import { takeGitlabSnapshot } from './forge-inbox-gitlab-snapshot'
import type { ForgeInboxLedger } from './forge-inbox-ledger'

/**
 * The production analysis runner: reads the pinned instance's current snapshot with the owner's
 * api-read credential, then hands the prompt to the host-owned protected turn. Nothing here can
 * reach GitLab's write API or a model on its own.
 */
export function createForgeProtectedAnalysisRunner(deps: {
  ledger: ForgeInboxLedger
  http: Pick<MainHttpClient, 'fetch'>
  turn: ForgeAnalysisTurn
  /** Defaults to every instance this owner has configured. */
  scope?: ForgeInstanceScope
}) {
  const { ledger, http, turn } = deps
  const scope = deps.scope ?? {}
  return createForgeAnalysisRunner({
    ledger,
    scope,
    readSnapshot: async (item, signal) => {
      const made = createForgeOwnerGitlabReader(
        { ledger, http, signal },
        { instanceId: item.instanceId, projectId: item.projectId }
      )
      if (!made.ok) {
        throw new Error(
          made.reason === 'instance-missing'
            ? 'forge_analysis_instance_missing'
            : 'forge_analysis_project_missing'
        )
      }
      const taken = await takeGitlabSnapshot(made.reader, item.kind, item.iid)
      if (!taken.ok) {
        // The reason names the failure without carrying any credential or response body.
        throw new Error(`forge_analysis_snapshot_unavailable:${taken.code}`)
      }
      return taken.snapshot
    },
    turn
  })
}

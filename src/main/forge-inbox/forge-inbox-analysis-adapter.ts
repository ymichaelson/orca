import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import type { MainHttpClient } from '../network/http-client'
import { ForgeCredentialUnavailableError } from './forge-inbox-credentials'
import { createGitlabApiReader } from './forge-inbox-gitlab-api-client'
import type { ForgeInboxConfig } from '../../shared/forge-inbox-config'
import type { ForgeAnalysisTurn } from './forge-inbox-analysis-runner'
import { createForgeAnalysisRunner } from './forge-inbox-analysis-runner'
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
      const { configRevision, config } = ledger.getConfig()
      const instance = config.instances.find((candidate) => candidate.id === item.instanceId)
      if (!instance) {
        throw new Error('forge_analysis_instance_missing')
      }
      const project = projectFor(instance, item.projectId)
      if (!project) {
        throw new Error('forge_analysis_project_missing')
      }
      // Read per run, like the webhook worker: a rotated credential or config revision applies to
      // the next analysis rather than to whatever was current when the service opened.
      const reader = createGitlabApiReader(
        {
          http,
          signal,
          readToken: () => {
            try {
              return ledger.readSecret(instance.id, 'api-read')?.secret ?? null
            } catch (error) {
              if (error instanceof ForgeCredentialUnavailableError) {
                return null
              }
              throw error
            }
          },
          readConfigRevision: () => ledger.getConfig().configRevision
        },
        {
          baseUrl: instance.baseUrl,
          projectId: project.projectId,
          expectedConfigRevision: configRevision
        }
      )
      const taken = await takeGitlabSnapshot(reader, item.kind, item.iid)
      if (!taken.ok) {
        // The reason names the failure without carrying any credential or response body.
        throw new Error(`forge_analysis_snapshot_unavailable:${taken.code}`)
      }
      return taken.snapshot
    },
    turn
  })
}

function projectFor(
  instance: ForgeInboxConfig['instances'][number],
  projectId: string
): ForgeInboxConfig['instances'][number]['projects'][number] | undefined {
  return instance.projects.find((candidate) => candidate.projectId === projectId)
}

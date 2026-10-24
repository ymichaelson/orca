import type { MainHttpClient } from '../network/http-client'
import { ForgeCredentialUnavailableError } from './forge-inbox-credentials'
import { createGitlabApiReader, type GitlabApiReader } from './forge-inbox-gitlab-api-client'
import type { ForgeInboxLedger } from './forge-inbox-ledger'

export type ForgeOwnerGitlabReaderResult =
  | { ok: true; reader: GitlabApiReader }
  | { ok: false; reason: 'instance-missing' | 'project-missing' }

/**
 * A reader bound to one configured instance and project, using the owner's api-read credential.
 * Both are resolved from the current config per call, so a rotated credential or revision applies
 * to the next read; a config that no longer names the target is a refusal, never a fallback.
 */
export function createForgeOwnerGitlabReader(
  deps: {
    ledger: Pick<ForgeInboxLedger, 'getConfig' | 'readSecret'>
    http: Pick<MainHttpClient, 'fetch'>
    signal: AbortSignal
  },
  target: { instanceId: string; projectId: string }
): ForgeOwnerGitlabReaderResult {
  const { configRevision, config } = deps.ledger.getConfig()
  const instance = config.instances.find((candidate) => candidate.id === target.instanceId)
  if (!instance) {
    return { ok: false, reason: 'instance-missing' }
  }
  const project = instance.projects.find((candidate) => candidate.projectId === target.projectId)
  if (!project) {
    return { ok: false, reason: 'project-missing' }
  }
  return {
    ok: true,
    reader: createGitlabApiReader(
      {
        http: deps.http,
        signal: deps.signal,
        readToken: () => {
          try {
            return deps.ledger.readSecret(instance.id, 'api-read')?.secret ?? null
          } catch (error) {
            // A keychain that cannot open is "no credential", not a crash the worker retries.
            if (error instanceof ForgeCredentialUnavailableError) {
              return null
            }
            throw error
          }
        },
        readConfigRevision: () => deps.ledger.getConfig().configRevision
      },
      {
        baseUrl: instance.baseUrl,
        projectId: project.projectId,
        expectedConfigRevision: configRevision
      }
    )
  }
}

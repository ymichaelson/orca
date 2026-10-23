import type { ForgePipelineFacts } from '../../shared/forge-inbox-types'
import type { GitlabHook } from './forge-inbox-gitlab-hook-payload'
import type { GitlabSnapshot } from './forge-inbox-gitlab-snapshot'

export type PipelineEventFacts = { observed?: ForgePipelineFacts; reported?: ForgePipelineFacts }

export type PipelineFactsVerdict =
  | { kind: 'unavailable' }
  | { kind: 'facts'; facts: PipelineEventFacts | undefined; observedFailed: boolean }

/**
 * Observed facts come only from the API snapshot; the hook's claim is kept as unverified history
 * and never selects the context, so a late hook for an older pipeline cannot roll it back.
 */
export function pipelineFactsFor(
  hook: GitlabHook,
  snapshot: GitlabSnapshot,
  onMergeRequest: boolean
): PipelineFactsVerdict {
  const observed = snapshot.observedPipeline ?? undefined
  if (hook.kind === 'pipeline' && onMergeRequest && !observed) {
    return { kind: 'unavailable' }
  }
  const reported: ForgePipelineFacts | undefined =
    hook.kind === 'pipeline'
      ? {
          id: hook.pipelineId,
          ...(hook.reportedSha === undefined ? {} : { sha: hook.reportedSha }),
          ...(hook.ref === undefined ? {} : { ref: hook.ref })
        }
      : undefined
  const facts = {
    ...(observed ? { observed } : {}),
    ...(reported ? { reported } : {})
  }
  return {
    kind: 'facts',
    facts: observed || reported ? facts : undefined,
    observedFailed: observed?.status === 'failed'
  }
}

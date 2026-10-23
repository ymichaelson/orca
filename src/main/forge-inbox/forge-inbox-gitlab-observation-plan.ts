import type { ForgeItemKind } from './forge-inbox-types'
import type { GitlabHook } from './forge-inbox-gitlab-hook-payload'
import {
  classifyGitlabHook,
  type GitlabProjectEvents,
  type GitlabRelevance,
  type GitlabRelevanceCategory
} from './forge-inbox-gitlab-relevance'
import {
  classifyGitlabSnapshot,
  type GitlabSnapshotSubject
} from './forge-inbox-gitlab-snapshot-relevance'

export type ObservationPlan =
  | { action: 'skip' }
  | {
      action: 'observe'
      kind: ForgeItemKind
      iid: number
      /** Null when only the verified snapshot can say why the item matters. */
      category: GitlabRelevanceCategory | null
      /** A pipeline on a merge request matters only if the user is involved in that request. */
      requiresInvolvement: boolean
    }

const SKIP: ObservationPlan = { action: 'skip' }

/** A fork pipeline's merge request lives in another project, so its iid must not be read here. */
function sameProjectMergeRequestIid(
  hook: Extract<GitlabHook, { kind: 'pipeline' }>
): number | undefined {
  const target = hook.mergeRequestTargetProjectId
  return target === undefined || target === hook.projectId ? hook.mergeRequestIid : undefined
}

/** Hooks only decide whether a snapshot is worth fetching; they never supply facts to store. */
export function planObservation(
  hook: GitlabHook,
  usernames: readonly string[],
  events: GitlabProjectEvents
): ObservationPlan {
  if (hook.kind === 'pipeline' && (hook.status !== 'failed' || !events.pipelineFailures)) {
    return SKIP
  }
  const mergeRequestIid = hook.kind === 'pipeline' ? sameProjectMergeRequestIid(hook) : undefined
  if (mergeRequestIid !== undefined) {
    return {
      action: 'observe',
      kind: 'merge_request',
      iid: mergeRequestIid,
      category: 'pipeline-failure',
      requiresInvolvement: true
    }
  }
  const relevance = classifyGitlabHook(hook, usernames, events)
  if (
    relevance.relevance === 'not-relevant' ||
    (relevance.relevance === 'relevant' && relevance.passive)
  ) {
    return SKIP
  }
  const category = relevance.relevance === 'relevant' ? relevance.category : null
  if (hook.kind === 'pipeline') {
    // A standalone pipeline has no participants to inspect: only its own trigger can matter.
    return category === null
      ? SKIP
      : {
          action: 'observe',
          kind: 'pipeline',
          iid: hook.pipelineId,
          category,
          requiresInvolvement: false
        }
  }
  const target = hook.kind === 'note' ? hook.noteable : hook.kind
  return { action: 'observe', kind: target, iid: hook.iid, category, requiresInvolvement: false }
}

/** Final category once the verified snapshot is known, or null when the item is not for this user. */
export function decideObservedCategory(
  plan: Extract<ObservationPlan, { action: 'observe' }>,
  subject: GitlabSnapshotSubject | null,
  usernames: readonly string[],
  events: GitlabProjectEvents
): GitlabRelevanceCategory | 'unknown' | null {
  if (plan.category !== null && !plan.requiresInvolvement) {
    return plan.category
  }
  const verdict: GitlabRelevance = subject
    ? classifyGitlabSnapshot(subject, usernames, events)
    : { relevance: 'not-relevant', passive: false }
  if (verdict.relevance === 'unknown') {
    return 'unknown'
  }
  if (verdict.relevance === 'not-relevant') {
    return null
  }
  if (plan.requiresInvolvement) {
    return events.pipelineFailures ? 'pipeline-failure' : null
  }
  return verdict.passive ? null : verdict.category
}

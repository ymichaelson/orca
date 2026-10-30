import type { GitlabApiErrorCode, GitlabApiReader } from './forge-inbox-gitlab-api-client'
import {
  buildIssueContext,
  buildMergeRequestContext,
  buildPipelineContext
} from './forge-inbox-gitlab-context'
import type { GitlabSnapshotSubject } from './forge-inbox-gitlab-snapshot-relevance'
import type { GitlabHeadPipeline, GitlabMergeRequest } from './forge-inbox-gitlab-api-schemas'
import type { ForgeAnalysisItemKind } from './forge-inbox-types'

const MAX_MERGE_REQUEST_ROUNDS = 2

export type GitlabSnapshot = {
  title: string
  itemState: string
  versionToken: string
  completeness: { complete: boolean; notes?: boolean; diffs?: boolean; ci?: boolean }
  /** The API-observed pipeline: a merge request's head pipeline (null if not exposed) or the pipeline itself. */
  observedPipeline?: GitlabHeadPipeline | null
  subject: GitlabSnapshotSubject | null
}

export type GitlabSnapshotResult =
  | { ok: true; snapshot: GitlabSnapshot }
  | { ok: false; code: GitlabApiErrorCode | 'head-moving' }

export function takeGitlabSnapshot(
  reader: GitlabApiReader,
  kind: ForgeAnalysisItemKind,
  iid: number
): Promise<GitlabSnapshotResult> {
  switch (kind) {
    case 'merge_request':
      return snapshotMergeRequest(reader, iid)
    case 'issue':
      return snapshotIssue(reader, iid)
    case 'pipeline':
      return snapshotPipeline(reader, iid)
  }
}

function comparisonIdentity(mergeRequest: GitlabMergeRequest): string | null {
  const refs = mergeRequest.diff_refs
  if (
    !mergeRequest.sha ||
    !mergeRequest.target_branch ||
    !refs?.base_sha ||
    !refs.start_sha ||
    !refs.head_sha ||
    refs.head_sha !== mergeRequest.sha
  ) {
    return null
  }
  return JSON.stringify([
    mergeRequest.sha,
    mergeRequest.target_branch,
    refs.base_sha,
    refs.start_sha,
    refs.head_sha
  ])
}

/** Rechecks the observed comparison identity; the REST reads are not an atomic snapshot. */
async function snapshotMergeRequest(
  reader: GitlabApiReader,
  iid: number
): Promise<GitlabSnapshotResult> {
  for (let round = 0; round < MAX_MERGE_REQUEST_ROUNDS; round += 1) {
    const before = await reader.getMergeRequest(iid)
    if (!before.ok) {
      return before
    }
    const identity = comparisonIdentity(before.data)
    if (identity === null) {
      continue
    }
    const diffs = await reader.getMergeRequestDiffs(iid)
    if (!diffs.ok) {
      return diffs
    }
    const notes = await reader.listMergeRequestNotes(iid)
    if (!notes.ok) {
      return notes
    }
    const after = await reader.getMergeRequest(iid)
    if (!after.ok) {
      return after
    }
    if (identity !== comparisonIdentity(after.data)) {
      continue
    }
    const mergeRequest = after.data
    const completeness = { notes: notes.complete, diffs: diffs.complete }
    const context = buildMergeRequestContext({
      mergeRequest,
      notes: notes.data,
      files: diffs.data,
      completeness
    })
    return {
      ok: true,
      snapshot: {
        title: mergeRequest.title,
        itemState: mergeRequest.state,
        versionToken: context.versionToken,
        // CI visibility never gates `complete`: reviews stay usable without it.
        completeness: { ...context.completeness, ci: mergeRequest.headPipeline !== null },
        observedPipeline: mergeRequest.headPipeline,
        subject: { kind: 'merge_request', mergeRequest }
      }
    }
  }
  return { ok: false, code: 'head-moving' }
}

async function snapshotIssue(reader: GitlabApiReader, iid: number): Promise<GitlabSnapshotResult> {
  const issue = await reader.getIssue(iid)
  if (!issue.ok) {
    return issue
  }
  const notes = await reader.listIssueNotes(iid)
  if (!notes.ok) {
    return notes
  }
  const context = buildIssueContext({
    issue: issue.data,
    notes: notes.data,
    completeness: { notes: notes.complete }
  })
  return {
    ok: true,
    snapshot: {
      title: issue.data.title,
      itemState: issue.data.state,
      versionToken: context.versionToken,
      completeness: context.completeness,
      subject: {
        kind: 'issue',
        issue: issue.data,
        notes: notes.data,
        notesComplete: notes.complete
      }
    }
  }
}

async function snapshotPipeline(
  reader: GitlabApiReader,
  id: number
): Promise<GitlabSnapshotResult> {
  const pipeline = await reader.getPipeline(id)
  if (!pipeline.ok) {
    return pipeline
  }
  const context = buildPipelineContext({ pipeline: pipeline.data })
  return {
    ok: true,
    snapshot: {
      title: `Pipeline #${pipeline.data.id}`,
      itemState: pipeline.data.status,
      versionToken: context.versionToken,
      completeness: context.completeness,
      observedPipeline: pipeline.data,
      subject: null
    }
  }
}

import type { GitlabApiReader } from './forge-inbox-gitlab-api-client'
import {
  buildIssueContext,
  buildMergeRequestContext,
  buildPipelineContext
} from './forge-inbox-gitlab-context'
import type { GitlabApiErrorCode } from './forge-inbox-gitlab-api-request'
import type { ForgeAnalysisItemKind } from './forge-inbox-types'

export type SnapshotDigest = { versionToken: string; completeness: { complete: boolean } }

export type SnapshotResult =
  | {
      ok: true
      stable: true
      digest: SnapshotDigest
      title: string
      itemState: string
      sha: string | null
    }
  | { ok: true; stable: false }
  | { ok: false; code: GitlabApiErrorCode }

/**
 * Reads one snapshot, then re-reads its head to prove the digest inputs did not move meanwhile.
 * `stable: false` means the caller may retry the whole snapshot; no bounded reads are repeated here.
 */
export async function observeSnapshot(
  reader: GitlabApiReader,
  kind: ForgeAnalysisItemKind,
  iid: number
): Promise<SnapshotResult> {
  if (kind === 'pipeline') {
    const pipeline = await reader.getPipeline(iid)
    if (!pipeline.ok) {
      return pipeline
    }
    return {
      ok: true,
      stable: true,
      digest: buildPipelineContext({ pipeline: pipeline.data }),
      title: `Pipeline #${pipeline.data.id}`,
      itemState: pipeline.data.status,
      sha: pipeline.data.sha
    }
  }
  if (kind === 'merge_request') {
    const first = await reader.getMergeRequest(iid)
    if (!first.ok) {
      return first
    }
    const notes = await reader.listMergeRequestNotes(iid)
    if (!notes.ok) {
      return notes
    }
    const files = await reader.getMergeRequestDiffs(iid)
    if (!files.ok) {
      return files
    }
    const rechecked = await reader.getMergeRequest(iid)
    if (!rechecked.ok) {
      return rechecked
    }
    const completeness = { notes: notes.complete, diffs: files.complete }
    const digest = buildMergeRequestContext({
      mergeRequest: first.data,
      notes: notes.data,
      files: files.data,
      completeness
    })
    const afterNotes = buildMergeRequestContext({
      mergeRequest: rechecked.data,
      notes: notes.data,
      files: files.data,
      completeness
    })
    if (digest.versionToken !== afterNotes.versionToken) {
      return { ok: true, stable: false }
    }
    return {
      ok: true,
      stable: true,
      digest,
      title: rechecked.data.title,
      itemState: rechecked.data.state,
      sha: rechecked.data.sha
    }
  }
  const first = await reader.getIssue(iid)
  if (!first.ok) {
    return first
  }
  const notes = await reader.listIssueNotes(iid)
  if (!notes.ok) {
    return notes
  }
  const rechecked = await reader.getIssue(iid)
  if (!rechecked.ok) {
    return rechecked
  }
  const completeness = { notes: notes.complete }
  const digest = buildIssueContext({
    issue: first.data,
    notes: notes.data,
    completeness
  })
  const afterNotes = buildIssueContext({
    issue: rechecked.data,
    notes: notes.data,
    completeness
  })
  if (digest.versionToken !== afterNotes.versionToken) {
    return { ok: true, stable: false }
  }
  return {
    ok: true,
    stable: true,
    digest,
    title: rechecked.data.title,
    itemState: rechecked.data.state,
    sha: null
  }
}

import { createHash } from 'node:crypto'
import { canonicalJson } from './forge-inbox-canonical-json'
import type {
  GitlabDiffFile,
  GitlabIssue,
  GitlabMergeRequest,
  GitlabNote,
  GitlabPipeline
} from './forge-inbox-gitlab-api-schemas'

export type GitlabContextDigest<Completeness> = {
  versionToken: string
  completeness: Completeness & { complete: boolean }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const sorted = (values: readonly string[]) => [...values].sort()

function digest<C extends Record<string, boolean>>(
  facts: unknown,
  completeness: C
): GitlabContextDigest<C> {
  const complete = Object.values(completeness).every(Boolean)
  return {
    versionToken: `sha256:${sha256(canonicalJson({ facts, completeness }))}`,
    completeness: { ...completeness, complete }
  }
}

// Note timestamps are excluded on purpose: only id, kind and body identify a note's content.
function noteFacts(notes: readonly GitlabNote[]) {
  return notes
    .map((note) => ({
      id: note.id,
      system: note.system,
      author: note.author,
      body: sha256(note.body)
    }))
    .sort((a, b) => a.id - b.id)
}

function fileFacts(files: readonly GitlabDiffFile[]) {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return files
    .map((file) => ({
      oldPath: file.old_path,
      newPath: file.new_path,
      diff: sha256(file.diff),
      newFile: file.new_file,
      renamed: file.renamed_file,
      deleted: file.deleted_file,
      generated: file.generated_file ?? false
    }))
    .sort(
      (a, b) =>
        compare(a.newPath, b.newPath) || compare(a.oldPath, b.oldPath) || compare(a.diff, b.diff)
    )
}

export function buildMergeRequestContext(snapshot: {
  mergeRequest: GitlabMergeRequest
  notes: readonly GitlabNote[]
  files: readonly GitlabDiffFile[]
  completeness: { notes: boolean; diffs: boolean }
}) {
  const { mergeRequest } = snapshot
  return digest(
    {
      kind: 'merge_request',
      iid: mergeRequest.iid,
      state: mergeRequest.state,
      title: mergeRequest.title,
      description: sha256(mergeRequest.description),
      targetBranch: mergeRequest.target_branch,
      author: mergeRequest.author,
      draft: mergeRequest.draft,
      sha: mergeRequest.sha,
      diffRefs: mergeRequest.diff_refs,
      reviewers: sorted(mergeRequest.reviewers),
      assignees: sorted(mergeRequest.assignees),
      notes: noteFacts(snapshot.notes),
      files: fileFacts(snapshot.files),
      headPipeline: mergeRequest.headPipeline
    },
    { notes: snapshot.completeness.notes, diffs: snapshot.completeness.diffs }
  )
}

export function buildPipelineContext(snapshot: { pipeline: GitlabPipeline }) {
  const { pipeline } = snapshot
  return digest(
    {
      kind: 'pipeline',
      id: pipeline.id,
      status: pipeline.status,
      sha: pipeline.sha,
      ref: pipeline.ref
    },
    {}
  )
}

export function buildIssueContext(snapshot: {
  issue: GitlabIssue
  notes: readonly GitlabNote[]
  completeness: { notes: boolean }
}) {
  const { issue } = snapshot
  return digest(
    {
      kind: 'issue',
      iid: issue.iid,
      state: issue.state,
      title: issue.title,
      description: sha256(issue.description),
      assignees: sorted(issue.assignees),
      notes: noteFacts(snapshot.notes)
    },
    { notes: snapshot.completeness.notes }
  )
}

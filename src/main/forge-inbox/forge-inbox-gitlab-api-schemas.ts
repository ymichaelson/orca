import { z } from 'zod'

const username = z.object({ username: z.string() }).transform((user) => user.username)
const text = z
  .string()
  .nullish()
  .transform((value) => value ?? '')
const usernames = z
  .array(username)
  .nullish()
  .transform((users) => users ?? [])

const headPipeline = z
  .object({ id: z.number().int(), status: z.string(), sha: z.string(), ref: z.string() })
  .strip()
  .nullish()
  .transform((pipeline) => pipeline ?? null)

export const gitlabMergeRequestSchema = z
  .object({
    iid: z.number().int(),
    state: z.string(),
    title: z.string(),
    description: text,
    target_branch: z
      .string()
      .nullish()
      .transform((branch) => branch ?? null),
    draft: z.boolean().nullish(),
    work_in_progress: z.boolean().nullish(),
    sha: z.string().nullable(),
    diff_refs: z
      .object({ base_sha: z.string(), head_sha: z.string(), start_sha: z.string() })
      .nullish()
      .transform((refs) => refs ?? null),
    author: username,
    reviewers: usernames,
    assignees: usernames,
    updated_at: z.string(),
    // Absent unless the user can view CI; null and absent both mean CI is unknown.
    head_pipeline: headPipeline
  })
  .strip()
  .transform(({ work_in_progress, draft, head_pipeline, ...mergeRequest }) => ({
    ...mergeRequest,
    draft: draft ?? work_in_progress ?? false,
    headPipeline: head_pipeline
  }))

export const gitlabNoteSchema = z
  .object({
    id: z.number().int(),
    system: z.boolean(),
    author: username,
    body: z.string(),
    updated_at: z.string()
  })
  .strip()

export const gitlabDiffFileSchema = z
  .object({
    old_path: z.string(),
    new_path: z.string(),
    diff: z.string(),
    new_file: z.boolean().default(false),
    renamed_file: z.boolean().default(false),
    deleted_file: z.boolean().default(false),
    generated_file: z.boolean().nullish().default(false)
  })
  .strip()

export const gitlabPipelineSchema = z
  .object({ id: z.number().int(), status: z.string(), sha: z.string(), ref: z.string() })
  .strip()

export const gitlabIssueSchema = z
  .object({
    iid: z.number().int(),
    state: z.string(),
    title: z.string(),
    description: text,
    assignees: usernames
  })
  .strip()

export const gitlabTreeEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.enum(['blob', 'tree', 'commit']),
    path: z.string(),
    mode: z.string()
  })
  .strip()

export const gitlabCommitSchema = z
  .object({
    id: z.string(),
    parent_ids: z.array(z.string()),
    author_name: z.string(),
    author_email: z.string(),
    authored_date: z.string(),
    committer_name: z.string(),
    committer_email: z.string(),
    committed_date: z.string(),
    message: z.string()
  })
  .strip()

export type GitlabHeadPipeline = NonNullable<GitlabMergeRequest['headPipeline']>
export type GitlabCommit = z.infer<typeof gitlabCommitSchema>
export type GitlabMergeRequest = z.infer<typeof gitlabMergeRequestSchema>
export type GitlabNote = z.infer<typeof gitlabNoteSchema>
export type GitlabDiffFile = z.infer<typeof gitlabDiffFileSchema>
export type GitlabPipeline = z.infer<typeof gitlabPipelineSchema>
export type GitlabIssue = z.infer<typeof gitlabIssueSchema>
export type GitlabTreeEntry = z.infer<typeof gitlabTreeEntrySchema>

import { z } from 'zod'

export type GitlabHook =
  | {
      kind: 'merge_request'
      projectId: number
      iid: number
      actor: string | undefined
      action: string | undefined
      state: string | undefined
      reviewers: string[] | undefined
      assignees: string[] | undefined
      reportedSha: string | undefined
      reportedAt: string | undefined
    }
  | {
      kind: 'note'
      noteable: 'merge_request' | 'issue'
      projectId: number
      iid: number
      actor: string | undefined
      noteId: number
      noteText: string
      system: boolean
      reportedSha: string | undefined
      reportedAt: string | undefined
    }
  | {
      kind: 'pipeline'
      projectId: number
      pipelineId: number
      actor: string | undefined
      status: string
      ref: string | undefined
      mergeRequestIid: number | undefined
      /** Absent on older GitLab payloads; a different project means the iid is not ours to read. */
      mergeRequestTargetProjectId: number | undefined
      reportedSha: string | undefined
      reportedAt: string | undefined
    }
  | {
      kind: 'issue'
      projectId: number
      iid: number
      actor: string | undefined
      action: string | undefined
      state: string | undefined
      description: string | undefined
      assignees: string[] | undefined
      reportedAt: string | undefined
    }

export type GitlabHookParseResult =
  | { ok: true; hook: GitlabHook }
  | { ok: false; reason: 'unsupported' | 'malformed' }

const OBJECT_KIND_BY_EVENT: Record<string, string> = {
  'Merge Request Hook': 'merge_request',
  'Note Hook': 'note',
  'Confidential Note Hook': 'note',
  'Pipeline Hook': 'pipeline',
  'Issue Hook': 'issue',
  'Confidential Issue Hook': 'issue'
}

const optionalText = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined)
// A deleted "ghost" user has no username; skipping it keeps the rest of the hook usable.
const users = z
  .array(z.object({ username: z.string().optional() }))
  .nullish()
  .transform((list) =>
    list?.flatMap((user) => (user.username === undefined ? [] : [user.username]))
  )
const common = {
  project: z.object({ id: z.number().int() }),
  user: z.object({ username: z.string().optional() }).nullish()
}
const lastCommit = z.object({ id: z.string() }).nullish()

const mergeRequestSchema = z.object({
  ...common,
  object_attributes: z.object({
    iid: z.number().int(),
    action: optionalText,
    state: optionalText,
    last_commit: lastCommit,
    updated_at: optionalText
  }),
  reviewers: users,
  assignees: users
})

const noteSchema = z.object({
  ...common,
  object_attributes: z.object({
    id: z.number().int(),
    note: z.string(),
    noteable_type: z.string(),
    system: z.boolean().nullish(),
    updated_at: optionalText
  }),
  merge_request: z.object({ iid: z.number().int(), last_commit: lastCommit }).nullish(),
  issue: z.object({ iid: z.number().int() }).nullish()
})

const pipelineSchema = z.object({
  ...common,
  object_attributes: z.object({
    id: z.number().int(),
    status: z.string(),
    ref: optionalText,
    sha: optionalText,
    finished_at: optionalText,
    created_at: optionalText
  }),
  merge_request: z
    .object({ iid: z.number().int(), target_project_id: z.number().int().nullish() })
    .nullish()
})

const issueSchema = z.object({
  ...common,
  object_attributes: z.object({
    iid: z.number().int(),
    action: optionalText,
    state: optionalText,
    description: optionalText,
    updated_at: optionalText
  }),
  assignees: users
})

const malformed = { ok: false, reason: 'malformed' } as const
const unsupported = { ok: false, reason: 'unsupported' } as const

/** Bodies are untrusted: unknown fields are dropped and any shape violation is `malformed`. */
export function parseGitlabHook(eventKind: string, body: Buffer): GitlabHookParseResult {
  const expectedKind = OBJECT_KIND_BY_EVENT[eventKind]
  if (expectedKind === undefined) {
    return unsupported
  }
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    return malformed
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return malformed
  }
  const objectKind = 'object_kind' in json ? json.object_kind : undefined
  if (typeof objectKind !== 'string') {
    return malformed
  }
  if (objectKind !== expectedKind) {
    // A known kind under the wrong header is inconsistent; an unknown kind (e.g. work_item) is new.
    return Object.values(OBJECT_KIND_BY_EVENT).includes(objectKind) ? malformed : unsupported
  }
  switch (expectedKind) {
    case 'merge_request':
      return parseMergeRequest(json)
    case 'note':
      return parseNote(json)
    case 'pipeline':
      return parsePipeline(json)
    default:
      return parseIssue(json)
  }
}

function parseMergeRequest(json: object): GitlabHookParseResult {
  const parsed = mergeRequestSchema.safeParse(json)
  if (!parsed.success) {
    return malformed
  }
  const { project, user, object_attributes: attrs, reviewers, assignees } = parsed.data
  return {
    ok: true,
    hook: {
      kind: 'merge_request',
      projectId: project.id,
      iid: attrs.iid,
      actor: user?.username,
      action: attrs.action,
      state: attrs.state,
      reviewers,
      assignees,
      reportedSha: attrs.last_commit?.id,
      reportedAt: attrs.updated_at
    }
  }
}

function parseNote(json: object): GitlabHookParseResult {
  const parsed = noteSchema.safeParse(json)
  if (!parsed.success) {
    return malformed
  }
  const { project, user, object_attributes: attrs, merge_request, issue } = parsed.data
  const target =
    attrs.noteable_type === 'MergeRequest'
      ? ({ noteable: 'merge_request', iid: merge_request?.iid } as const)
      : attrs.noteable_type === 'Issue'
        ? ({ noteable: 'issue', iid: issue?.iid } as const)
        : null
  if (target === null) {
    return unsupported
  }
  if (target.iid === undefined) {
    return malformed
  }
  return {
    ok: true,
    hook: {
      kind: 'note',
      noteable: target.noteable,
      projectId: project.id,
      iid: target.iid,
      actor: user?.username,
      noteId: attrs.id,
      noteText: attrs.note,
      system: attrs.system ?? false,
      reportedSha: merge_request?.last_commit?.id,
      reportedAt: attrs.updated_at
    }
  }
}

function parsePipeline(json: object): GitlabHookParseResult {
  const parsed = pipelineSchema.safeParse(json)
  if (!parsed.success) {
    return malformed
  }
  const { project, user, object_attributes: attrs, merge_request } = parsed.data
  return {
    ok: true,
    hook: {
      kind: 'pipeline',
      projectId: project.id,
      pipelineId: attrs.id,
      actor: user?.username,
      status: attrs.status,
      ref: attrs.ref,
      mergeRequestIid: merge_request?.iid,
      mergeRequestTargetProjectId: merge_request?.target_project_id ?? undefined,
      reportedSha: attrs.sha,
      reportedAt: attrs.finished_at ?? attrs.created_at
    }
  }
}

function parseIssue(json: object): GitlabHookParseResult {
  const parsed = issueSchema.safeParse(json)
  if (!parsed.success) {
    return malformed
  }
  const { project, user, object_attributes: attrs, assignees } = parsed.data
  return {
    ok: true,
    hook: {
      kind: 'issue',
      projectId: project.id,
      iid: attrs.iid,
      actor: user?.username,
      action: attrs.action,
      state: attrs.state,
      description: attrs.description,
      assignees,
      reportedAt: attrs.updated_at
    }
  }
}

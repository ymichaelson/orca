import { createHash } from 'node:crypto'
import { clampUtf8TextPrefix } from '../../shared/utf8-byte-limits'
import { isRecord } from './forge-inbox-rows'

const REF_BYTES = 256
const SHA_BYTES = 64
const MESSAGE_BYTES = 240
const MAX_COMMITS = 10

export const PROJECT_PUSH_OBJECT_KINDS = ['push', 'tag_push'] as const
export type ProjectPushObjectKind = (typeof PROJECT_PUSH_OBJECT_KINDS)[number]

export type ProjectPushSummary = {
  event: ProjectPushObjectKind
  /** The project the payload says it belongs to; null when it says none. */
  projectId: number | null
  ref: string
  before: string | null
  after: string
  totalCommits: number | null
  commits: { id: string; message: string }[]
}

function boundedText(value: unknown, bytes: number): string | null {
  return typeof value === 'string' ? clampUtf8TextPrefix(value, bytes) : null
}

function firstLine(message: string): string {
  return message.split(/\r?\n/, 1)[0] ?? ''
}

function commitsOf(value: unknown): ProjectPushSummary['commits'] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.slice(0, MAX_COMMITS).flatMap((commit: unknown) => {
    if (!isRecord(commit)) {
      return []
    }
    const id = boundedText(commit.id, SHA_BYTES)
    const message = typeof commit.message === 'string' ? commit.message : ''
    return id === null
      ? []
      : [{ id, message: clampUtf8TextPrefix(firstLine(message), MESSAGE_BYTES) }]
  })
}

function projectIdOf(body: Record<string, unknown>): number | null {
  const reported = isRecord(body.project) ? body.project.id : body.project_id
  return typeof reported === 'number' && Number.isSafeInteger(reported) ? reported : null
}

/** Null when the body is not a push-shaped event with the ref and head it must report. */
export function parseProjectPush(
  body: Uint8Array
): (ProjectPushSummary & { fingerprint: string }) | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }
  const event = PROJECT_PUSH_OBJECT_KINDS.find((kind) => kind === parsed.object_kind)
  const ref = boundedText(parsed.ref, REF_BYTES)
  const after = boundedText(parsed.after, SHA_BYTES)
  if (event === undefined || ref === null || after === null) {
    return null
  }
  const total = parsed.total_commits_count
  return {
    event,
    projectId: projectIdOf(parsed),
    fingerprint: projectEventFingerprint([event, parsed.ref, parsed.after]),
    ref,
    before: boundedText(parsed.before, SHA_BYTES),
    after,
    totalCommits: typeof total === 'number' && Number.isSafeInteger(total) ? total : null,
    commits: commitsOf(parsed.commits)
  }
}

export function projectEventFingerprint(identity: unknown[]): string {
  return `v2:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
}

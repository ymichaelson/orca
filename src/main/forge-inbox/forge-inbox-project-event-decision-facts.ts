import { isRecord } from './forge-inbox-rows'

export const PROJECT_EVENT_DECISION_INPUT_VERSION = 4

/**
 * The facts each kind is expected to report. A kind's payload never carries another kind's fields, so
 * reporting those as missing would read as incomplete context and invite a fetch that cannot help.
 */
const PROJECT_EVENT_EXPECTED_FACTS: Record<string, readonly string[]> = {
  merge_request: [
    'itemId',
    'iid',
    'action',
    'state',
    'title',
    'sourceBranch',
    'targetBranch',
    'sha',
    'text'
  ],
  issue: ['itemId', 'iid', 'action', 'state', 'title', 'text'],
  note: ['itemId', 'iid', 'action', 'text'],
  pipeline: ['itemId', 'state', 'sha', 'ref'],
  push: ['sha', 'ref'],
  tag_push: ['sha', 'ref'],
  release: ['action', 'itemId', 'title', 'tag', 'text'],
  deployment: ['itemId', 'state', 'environment']
}

export function persistedProjectEventFacts(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || (parsed.kind !== 'release' && parsed.kind !== 'deployment')) {
    return null
  }
  const facts: Record<string, unknown> = { kind: parsed.kind }
  for (const key of [
    'action',
    'itemId',
    'sha',
    'ref',
    'state',
    'title',
    'text',
    'tag',
    'environment'
  ]) {
    const value = parsed[key]
    if (typeof value === 'string') {
      facts[key] = value.slice(0, key === 'text' ? 4096 : key === 'title' ? 512 : 256)
    } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
      facts[key] = value
    }
  }
  return facts
}

/** The object a hook reports facts about; a pipeline only refers to its merge request. */
export function projectEventReportedItem(
  parsed: Record<string, unknown>,
  attributes: Record<string, unknown>
): Record<string, unknown> {
  if (parsed.object_kind === 'pipeline') {
    return attributes
  }
  return isRecord(parsed.merge_request)
    ? parsed.merge_request
    : isRecord(parsed.issue)
      ? parsed.issue
      : attributes
}

export function projectEventDecisionFacts(body: unknown): Record<string, unknown> {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array()
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!isRecord(parsed)) {
    throw new Error('invalid event body')
  }
  if (typeof parsed.object_kind !== 'string' || parsed.object_kind.length === 0) {
    throw new Error('invalid event kind')
  }
  if (
    ![
      'merge_request',
      'issue',
      'note',
      'pipeline',
      'push',
      'tag_push',
      'release',
      'deployment'
    ].includes(parsed.object_kind)
  ) {
    return {
      kind: 'unknown',
      completeness: 'insufficient-facts',
      missing: ['recognized-kind'],
      truncated: []
    }
  }
  const attributes = isRecord(parsed.object_attributes) ? parsed.object_attributes : {}
  const item = projectEventReportedItem(parsed, attributes)
  const commit = isRecord(attributes.last_commit) ? attributes.last_commit : {}
  const rootEvent = parsed.object_kind === 'release' || parsed.object_kind === 'deployment'
  const candidates: Record<string, unknown> = {
    kind: parsed.object_kind,
    action: rootEvent ? parsed.action : attributes.action,
    itemId: rootEvent ? (parsed.id ?? parsed.deployment_id) : item.id,
    iid: item.iid,
    sha:
      attributes.sha ??
      attributes.last_commit_id ??
      commit.id ??
      parsed.checkout_sha ??
      parsed.after,
    ref: attributes.ref ?? parsed.ref,
    sourceBranch: item.source_branch,
    targetBranch: item.target_branch,
    state: rootEvent ? parsed.status : (attributes.state ?? attributes.status ?? item.state),
    title: rootEvent ? parsed.name : item.title,
    text: rootEvent
      ? parsed.description
      : (attributes.note ?? attributes.description ?? item.description),
    ...(rootEvent ? { tag: parsed.tag, environment: parsed.environment } : {})
  }
  const expected = PROJECT_EVENT_EXPECTED_FACTS[parsed.object_kind] ?? []
  const facts: Record<string, unknown> = {}
  const missing: string[] = []
  const truncated: string[] = []
  for (const [key, value] of Object.entries(candidates)) {
    if (typeof value === 'string') {
      const limit = key === 'text' ? 4096 : key === 'title' ? 512 : 256
      facts[key] = value.slice(0, limit)
      if (value.length > limit) {
        truncated.push(key)
      }
    } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
      facts[key] = value
    } else if (expected.includes(key)) {
      missing.push(key)
    }
  }
  return { ...facts, missing, truncated }
}

import { projectEventReportedItem } from './forge-inbox-project-event-decision-facts'
import { isRecord } from './forge-inbox-rows'

function textFact(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The model's decision facts omit notability and conflicts, which notify and wait must branch on. */
export function projectEventActionFacts(body: unknown): Record<string, unknown> {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array()
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return {}
  }
  if (!isRecord(parsed)) {
    return {}
  }
  const attributes = isRecord(parsed.object_attributes) ? parsed.object_attributes : {}
  const item = projectEventReportedItem(parsed, attributes)
  const kind = textFact(parsed.object_kind)
  const rootEvent = kind === 'release' || kind === 'deployment'
  const status = textFact(rootEvent ? parsed.status : attributes.status)
  const state = textFact(attributes.state) ?? textFact(item.state)
  const action = textFact(rootEvent ? parsed.action : attributes.action)
  const iid = item.iid
  const title = textFact(item.title)
  const noteableType = textFact(attributes.noteable_type)
  const hasConflicts = attributes.has_conflicts ?? item.has_conflicts
  const mergeStatus =
    textFact(attributes.merge_status) ??
    textFact(attributes.detailed_merge_status) ??
    textFact(item.merge_status)
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(typeof iid === 'number' && Number.isSafeInteger(iid) ? { iid } : {}),
    ...(title === undefined ? {} : { title }),
    ...(action === undefined ? {} : { action }),
    ...(status === undefined ? {} : { status }),
    ...(state === undefined ? {} : { state }),
    ...(noteableType === undefined ? {} : { noteableType }),
    ...(typeof hasConflicts === 'boolean' ? { hasConflicts } : {}),
    ...(mergeStatus === undefined ? {} : { mergeStatus })
  }
}

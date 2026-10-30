import type { ForgeEventSummary, ForgePipelineFacts } from '../../shared/forge-inbox-types'
import { GITLAB_RELEVANCE_CATEGORIES } from './forge-inbox-gitlab-relevance'

const MAX_FACT_TEXT = 512

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

function completenessOf(value: unknown): ForgeEventSummary['completeness'] {
  const fields = record(value)
  if (!fields || typeof fields.complete !== 'boolean') {
    return undefined
  }
  return {
    complete: fields.complete,
    ...(typeof fields.notes === 'boolean' ? { notes: fields.notes } : {}),
    ...(typeof fields.diffs === 'boolean' ? { diffs: fields.diffs } : {}),
    ...(typeof fields.ci === 'boolean' ? { ci: fields.ci } : {})
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_FACT_TEXT ? value : undefined
}

function pipelineFactsOf(value: unknown): ForgePipelineFacts | undefined {
  const fields = record(value)
  if (!fields || !Number.isSafeInteger(fields.id)) {
    return undefined
  }
  const [status, sha, ref] = [text(fields.status), text(fields.sha), text(fields.ref)]
  return {
    id: Number(fields.id),
    ...(status === undefined ? {} : { status }),
    ...(sha === undefined ? {} : { sha }),
    ...(ref === undefined ? {} : { ref })
  }
}

function pipelineOf(value: unknown): ForgeEventSummary['pipeline'] {
  const fields = record(value)
  const observed = pipelineFactsOf(fields?.observed)
  const reported = pipelineFactsOf(fields?.reported)
  return observed || reported
    ? { ...(observed ? { observed } : {}), ...(reported ? { reported } : {}) }
    : undefined
}

/** Whitelist only: stored payloads can carry bodies and headers, and a bad row must not throw. */
export function summarizeForgeEventPayload(payloadJson: string): ForgeEventSummary {
  let parsed: unknown
  try {
    parsed = JSON.parse(payloadJson)
  } catch {
    return {}
  }
  const payload = record(parsed)
  if (!payload) {
    return {}
  }
  const category = [...GITLAB_RELEVANCE_CATEGORIES, 'project-event'].find(
    (known) => known === payload.category
  )
  const completeness = completenessOf(payload.completeness)
  const pipeline = pipelineOf(payload.pipeline)
  return {
    ...(category ? { category } : {}),
    ...(payload.passive === true ? { passive: true } : {}),
    ...(completeness ? { completeness } : {}),
    ...(pipeline ? { pipeline } : {})
  }
}

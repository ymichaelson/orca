/** One normalize function per shared setting; the rules one keeps the same limits the owner enforces. */
import { z } from 'zod'
import { MAX_RULES_BYTES } from './forge-inbox-config'
import { DEFAULT_PROJECT_EVENT_RULES } from './project-event-default-rules'

/** The wire shape of the global template: the same bounds the per-project policy schema enforces. */
export const projectEventDefaultRulesSchema = z
  .string()
  .refine((value) => !value.includes('\u0000'))
  .refine((value) => new TextEncoder().encode(value).length <= MAX_RULES_BYTES)

/** A valid value passes through; a hand-edited or oversized one falls back to the shipped template. */
export function normalizeProjectEventDefaultRules(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_PROJECT_EVENT_RULES
  }
  if (value.includes('\u0000') || new TextEncoder().encode(value).length > MAX_RULES_BYTES) {
    return DEFAULT_PROJECT_EVENT_RULES
  }
  return value
}

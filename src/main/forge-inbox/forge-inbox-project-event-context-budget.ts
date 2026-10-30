import { isRecord } from './forge-inbox-rows'

/** Only round 0 may read: round 1 already reaches the cap, so a chain fetches GitLab once. */
export const PROJECT_EVENT_CONTEXT_MAX_ROUNDS = 2

/** A missing, unreadable or forged round reads as zero and is clamped to the cap. */
export function projectEventContextRound(body: unknown): number {
  if (!(body instanceof Uint8Array)) {
    return 0
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
    if (!isRecord(parsed)) {
      return 0
    }
    const round = parsed.context_round
    if (typeof round !== 'number' || !Number.isSafeInteger(round) || round < 0) {
      return 0
    }
    return Math.min(round, PROJECT_EVENT_CONTEXT_MAX_ROUNDS)
  } catch {
    return 0
  }
}

/** Whether a fetch from this round is still inside the cap; the decision is told so it can stop. */
export function projectEventContextFetchAvailable(round: number): boolean {
  return round + 1 < PROJECT_EVENT_CONTEXT_MAX_ROUNDS
}

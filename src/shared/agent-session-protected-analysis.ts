import { isForgeAnalysisItemKind, type ForgeAnalysisItemKind } from './forge-inbox-types'

/** Ordinary records stay at 2 so every build reads them; a protected record is 3 so a build that
 *  only knows 2 does not recognize it. */
export const AGENT_SESSION_PROTECTED_RECORD_SCHEMA_VERSION = 3 as const

/** Host-authored so naming never reads a protected prompt. */
export const PROTECTED_ANALYSIS_CONVERSATION_NAME = 'Forge analysis'

/** The Forge item a conversation analyzes. Set once by host founding and never changed. */
export type AgentSessionProtectedAnalysis = {
  ownerId: string
  instanceId: string
  itemId: string
  analysisKind: ForgeAnalysisItemKind
}

const MARKER_KEYS = ['ownerId', 'instanceId', 'itemId', 'analysisKind']
const MAX_MARKER_ID_LENGTH = 512
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const POSITIVE_INTEGER = /^[1-9][0-9]{0,15}$/

export function isAgentSessionProtectedAnalysis(
  value: unknown
): value is AgentSessionProtectedAnalysis {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const keys = Object.keys(value)
  const ownerId = Reflect.get(value, 'ownerId')
  const instanceId = Reflect.get(value, 'instanceId')
  const itemId = Reflect.get(value, 'itemId')
  const analysisKind = Reflect.get(value, 'analysisKind')
  return (
    keys.length === MARKER_KEYS.length &&
    keys.every((key) => MARKER_KEYS.includes(key)) &&
    typeof ownerId === 'string' &&
    CANONICAL_UUID.test(ownerId) &&
    typeof instanceId === 'string' &&
    instanceId.length > 0 &&
    instanceId.length <= MAX_MARKER_ID_LENGTH &&
    typeof itemId === 'string' &&
    POSITIVE_INTEGER.test(itemId) &&
    typeof analysisKind === 'string' &&
    isForgeAnalysisItemKind(analysisKind)
  )
}

export function agentSessionProtectedAnalysisEqual(
  left: AgentSessionProtectedAnalysis | undefined,
  right: AgentSessionProtectedAnalysis | undefined
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.ownerId === right.ownerId &&
      left.instanceId === right.instanceId &&
      left.itemId === right.itemId &&
      left.analysisKind === right.analysisKind)
  )
}

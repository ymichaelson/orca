import type { ForgeInboxErrorSource } from '../../shared/forge-inbox-error-source'

export function forgeActionErrorSource(
  action: string | null,
  errorCode: string | null
): ForgeInboxErrorSource {
  // Dispatch can fail before observation or inside the agent; its action alone proves neither source.
  return action === 'fetch_context' && (errorCode === 'unauthorized' || errorCode === 'network')
    ? 'gitlab'
    : 'unknown'
}

export function forgeDeliveryErrorSource(input: {
  decisionState: string | null
  action: string | null
  deliveryError: string | null
  actionError: string | null
}): ForgeInboxErrorSource {
  if (
    input.deliveryError !== null &&
    (input.deliveryError === 'unauthorized' || input.deliveryError === 'network') &&
    (input.decisionState === 'blocked' || input.decisionState === 'retry')
  ) {
    return 'decision-provider'
  }
  const errorCode = input.deliveryError ?? input.actionError
  return input.decisionState === 'decided'
    ? forgeActionErrorSource(input.action, errorCode)
    : 'unknown'
}

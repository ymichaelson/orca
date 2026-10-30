/** How far a stop request got; none of these says the agent stopped, only the run's own settled state does. */
export const FORGE_RUN_CANCEL_DELIVERIES = [
  'pending',
  'accepted',
  'refused',
  'unreachable'
] as const
export type ForgeRunCancelDelivery = (typeof FORGE_RUN_CANCEL_DELIVERIES)[number]

export type ForgeRunCancellationView = {
  requestedAt: number
  delivery: ForgeRunCancelDelivery
}

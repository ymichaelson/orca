export const PROJECT_EVENT_RECEIVER_LISTENER_ERROR_CODES = {
  addressInUse: 'EADDRINUSE',
  permissionDenied: 'EACCES',
  addressNotAvailable: 'EADDRNOTAVAIL',
  listenFailed: 'listen-failed',
  externalPlaintextNotAcknowledged: 'external-plaintext-not-acknowledged',
  listenerStopped: 'listener-stopped'
} as const

export type ProjectEventReceiverListenerErrorCode =
  (typeof PROJECT_EVENT_RECEIVER_LISTENER_ERROR_CODES)[keyof typeof PROJECT_EVENT_RECEIVER_LISTENER_ERROR_CODES]

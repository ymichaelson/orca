// Marks implemented owner RPC support, not storage health; availability is reported by getStatus.
export const FORGE_INBOX_RUNTIME_CAPABILITY = 'forge-inbox.v1' as const

// Static marker that this server can publish Forge notifications; not storage health.
export const FORGE_INBOX_NOTIFICATIONS_RUNTIME_CAPABILITY = 'forge-inbox.notifications.v1' as const

// Advertised by an authenticated client whose app-lifetime bridge can route Forge notifications.
export const FORGE_INBOX_NOTIFICATION_READER_CAPABILITY =
  'forge-inbox.notifications-reader.v1' as const

export const FORGE_INBOX_RUNTIME_CAPABILITIES = [
  FORGE_INBOX_RUNTIME_CAPABILITY,
  FORGE_INBOX_NOTIFICATIONS_RUNTIME_CAPABILITY,
  'forge-inbox.changes-stream.v1',
  'forge-inbox.project-policy.v1'
] as const

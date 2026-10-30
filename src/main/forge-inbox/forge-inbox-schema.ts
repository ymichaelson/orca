export const FORGE_INBOX_SCHEMA_VERSION = 19

export const FORGE_INBOX_V1_TABLES = [
  'meta',
  'policies',
  'instance_origins',
  'credentials',
  'changes',
  'items',
  'item_revisions',
  'deliveries',
  'webhook_deliveries',
  'project_invalidations',
  'events',
  'runs',
  'proposals',
  'receipts',
  'item_reads',
  'client_cursors'
] as const

// Frozen at the shipped version 2 so migration never reinterprets the old file with a new shape.
export const FORGE_INBOX_V2_TABLES = [...FORGE_INBOX_V1_TABLES, 'patch_requests'] as const

export const FORGE_INBOX_V4_TABLES = [
  ...FORGE_INBOX_V2_TABLES,
  'project_bindings',
  'project_event_policies',
  'project_event_repo_links'
] as const

export const FORGE_INBOX_TABLES = [...FORGE_INBOX_V4_TABLES, 'project_event_decisions'] as const

export {
  FORGE_INBOX_V1_TABLES_SQL,
  FORGE_INBOX_V2_TABLES_SQL,
  createForgeInboxPatchRequestsTableSql
} from './forge-inbox-schema-base-tables'
export {
  createForgeInboxProjectBindingsTableSql,
  createForgeInboxProjectEventDecisionsTableSql,
  createForgeInboxProjectEventPoliciesTableSql,
  createForgeInboxProjectEventRepoLinksTableSql,
  createForgeInboxProjectEventTablesSql,
  createForgeInboxV3TablesSql,
  createForgeInboxV4TablesSql,
  createForgeInboxV5TablesSql,
  createForgeInboxWebhookDeliveriesV4Sql,
  migrateForgeInboxToV4Sql
} from './forge-inbox-schema-project-event-tables'
export {
  createForgeInboxV6TablesSql,
  createForgeInboxV7TablesSql,
  createForgeInboxV8TablesSql,
  migrateForgeInboxToV6Sql,
  migrateForgeInboxToV7Sql,
  migrateForgeInboxToV8Sql
} from './forge-inbox-schema-project-event-migrations'

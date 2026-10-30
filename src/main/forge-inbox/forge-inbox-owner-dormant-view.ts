import {
  DEFAULT_FORGE_INBOX_CONFIG,
  FORGE_INBOX_CONFIG_SCHEMA_VERSION,
  type ForgeInboxConfigView
} from '../../shared/forge-inbox-config'

/** The view of a ledger not created yet; creating the file stays a separate, explicit act. */
export function forgeOwnerDormantView(hostId: string): ForgeInboxConfigView {
  return {
    hostId,
    configRevision: 0,
    schemaVersion: FORGE_INBOX_CONFIG_SCHEMA_VERSION,
    config: structuredClone(DEFAULT_FORGE_INBOX_CONFIG),
    credentials: []
  }
}

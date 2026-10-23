import {
  DEFAULT_FORGE_INBOX_CONFIG,
  FORGE_INBOX_CONFIG_SCHEMA_VERSION,
  parseForgeInboxConfig,
  type ForgeCredentialStatus,
  type ForgeInboxConfig,
  type ForgeInboxConfigView
} from '../../shared/forge-inbox-config'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { ForgeInboxCorruptError, runForgeTransaction } from './forge-inbox-database'
import { bumpForgePolicyGenerationInTransaction } from './forge-inbox-policy'
import { rowText } from './forge-inbox-rows'
import { settleForgeUndeliverableWebhookDeliveries } from './forge-inbox-webhook-delivery-state'

const CONFIG_KEY = 'config_json'
const REVISION_KEY = 'config_revision'

export type ForgeConfigUpdateResult =
  | { ok: true; configRevision: number }
  | { ok: false; reason: 'stale-revision'; configRevision: number }
  | { ok: false; reason: 'invalid-config'; message: string }
  | { ok: false; reason: 'instance-origin-conflict'; instanceId: string }

type ConfigState = { revision: number; config: ForgeInboxConfig }

export function readForgeConfigState(ctx: ForgeLedgerContext): ConfigState {
  const meta = new Map(
    ctx.db
      .prepare('SELECT key, value FROM meta WHERE key IN (?, ?)')
      .all(CONFIG_KEY, REVISION_KEY)
      .map((row) => [rowText(row, 'key'), rowText(row, 'value')])
  )
  const stored = meta.get(CONFIG_KEY)
  if (stored === undefined) {
    return { revision: 0, config: structuredClone(DEFAULT_FORGE_INBOX_CONFIG) }
  }
  const revision = Number(meta.get(REVISION_KEY))
  let parsed: ReturnType<typeof parseForgeInboxConfig>
  try {
    parsed = parseForgeInboxConfig(JSON.parse(stored))
  } catch {
    parsed = { ok: false, message: 'not JSON' }
  }
  if (!parsed.ok || !Number.isSafeInteger(revision) || revision < 1) {
    throw new ForgeInboxCorruptError('forge inbox stored configuration is unreadable')
  }
  return { revision, config: parsed.config }
}

function upsertMeta(ctx: ForgeLedgerContext, key: string, value: string): void {
  ctx.db
    .prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}

/** Advances the revision inside the caller's write transaction. */
export function bumpForgeConfigRevision(ctx: ForgeLedgerContext, current: number): number {
  upsertMeta(ctx, REVISION_KEY, String(current + 1))
  return current + 1
}

/** The single in-transaction write of the stored config; callers decide which policies it revokes. */
export function commitForgeConfigInTransaction(
  ctx: ForgeLedgerContext,
  currentRevision: number,
  next: ForgeInboxConfig
): number {
  upsertMeta(ctx, CONFIG_KEY, JSON.stringify(next))
  settleForgeUndeliverableWebhookDeliveries(ctx, (instanceId, projectId) =>
    next.instances.some(
      (instance) =>
        instance.id === instanceId &&
        instance.projects.some((project) => project.projectId === projectId && project.enabled)
    )
  )
  return bumpForgeConfigRevision(ctx, currentRevision)
}

/** Revokes pending work of every project that is configured or already has items under the instances. */
export function invalidateForgeInstancePolicies(
  ctx: ForgeLedgerContext,
  instanceIds: ReadonlySet<string>,
  configs: ForgeInboxConfig[]
): void {
  const scopes = new Map<string, { instanceId: string; projectId: string }>()
  const add = (instanceId: string, projectId: string) => {
    if (instanceIds.has(instanceId)) {
      scopes.set(JSON.stringify([instanceId, projectId]), { instanceId, projectId })
    }
  }
  for (const config of configs) {
    for (const instance of config.instances) {
      for (const project of instance.projects) {
        add(instance.id, project.projectId)
      }
    }
  }
  for (const row of ctx.db
    .prepare('SELECT DISTINCT instance_id, project_id FROM items WHERE host_id = ?')
    .all(ctx.hostId)) {
    add(rowText(row, 'instance_id'), rowText(row, 'project_id'))
  }
  for (const scope of scopes.values()) {
    bumpForgePolicyGenerationInTransaction(ctx, scope)
  }
}

export function getForgeConfig(ctx: ForgeLedgerContext): ForgeInboxConfigView {
  const { revision, config } = readForgeConfigState(ctx)
  const configured = new Set(config.instances.map((instance) => instance.id))
  const credentials: ForgeCredentialStatus[] = []
  for (const row of ctx.db
    .prepare(
      'SELECT instance_id, kind, protection, gap FROM credentials ORDER BY instance_id, kind'
    )
    .all()) {
    const instanceId = rowText(row, 'instance_id')
    if (configured.has(instanceId)) {
      credentials.push({
        instanceId,
        kind: credentialKind(rowText(row, 'kind')),
        protection: rowText(row, 'protection') === 'sealed' ? 'sealed' : 'plaintext',
        gap: row.gap === null ? null : rowText(row, 'gap')
      })
    }
  }
  return {
    hostId: ctx.hostId,
    configRevision: revision,
    schemaVersion: FORGE_INBOX_CONFIG_SCHEMA_VERSION,
    config,
    credentials
  }
}

function credentialKind(value: string): ForgeCredentialStatus['kind'] {
  if (value === 'webhook' || value === 'api-read' || value === 'api-write') {
    return value
  }
  throw new ForgeInboxCorruptError(`forge inbox credential kind ${value} is unknown`)
}

export function updateForgeConfig(
  ctx: ForgeLedgerContext,
  expectedRevision: number,
  input: unknown
): ForgeConfigUpdateResult {
  const parsed = parseForgeInboxConfig(input)
  if (!parsed.ok) {
    return { ok: false, reason: 'invalid-config', message: parsed.message }
  }
  const next = parsed.config
  return runForgeTransaction(ctx.db, (): ForgeConfigUpdateResult => {
    const current = readForgeConfigState(ctx)
    if (current.revision !== expectedRevision) {
      return { ok: false, reason: 'stale-revision', configRevision: current.revision }
    }
    const bound = new Map(
      ctx.db
        .prepare('SELECT instance_id, base_url FROM instance_origins')
        .all()
        .map((row) => [rowText(row, 'instance_id'), rowText(row, 'base_url')])
    )
    for (const instance of next.instances) {
      const origin = bound.get(instance.id)
      if (origin !== undefined && origin !== instance.baseUrl) {
        return { ok: false, reason: 'instance-origin-conflict', instanceId: instance.id }
      }
    }
    const kept = new Set(next.instances.map((instance) => instance.id))
    const affected = new Set([...current.config.instances.map((i) => i.id), ...kept])
    for (const instance of next.instances) {
      ctx.db
        .prepare('INSERT OR IGNORE INTO instance_origins (instance_id, base_url) VALUES (?, ?)')
        .run(instance.id, instance.baseUrl)
    }
    for (const instance of current.config.instances) {
      if (!kept.has(instance.id)) {
        ctx.db.prepare('DELETE FROM credentials WHERE instance_id = ?').run(instance.id)
      }
    }
    const configRevision = commitForgeConfigInTransaction(ctx, current.revision, next)
    invalidateForgeInstancePolicies(ctx, affected, [current.config, next])
    return { ok: true, configRevision }
  })
}

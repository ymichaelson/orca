import {
  FORGE_CREDENTIAL_MAX_BYTES,
  type ForgeCredentialKind,
  type ForgeCredentialProtection
} from '../../shared/forge-inbox-config'
import type { SecretStore } from '../../shared/secret-store'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import {
  bumpForgeConfigRevision,
  invalidateForgeInstancePolicies,
  readForgeConfigState
} from './forge-inbox-config'
import { rowText } from './forge-inbox-rows'
import { requeueForgeWebhookNeedsAuth } from './forge-inbox-webhook-delivery-state'

const VISIBLE_ASCII = /^[\x21-\x7e]+$/
const NO_ENCRYPTION_GAP = 'encryption is unavailable on this host'

type CredentialTarget = {
  instanceId: string
  kind: ForgeCredentialKind
  expectedRevision: number
}

export type ForgeCredentialWriteResult =
  | { ok: true; configRevision: number; protection: ForgeCredentialProtection | null }
  | { ok: false; reason: 'stale-revision'; configRevision: number }
  | { ok: false; reason: 'unknown-instance' | 'invalid-secret' }
  | { ok: false; reason: 'unprotected-storage'; gap: string }

export type ForgeRevealedSecret = {
  secret: string
  protection: ForgeCredentialProtection
  gap: string | null
}

type Envelope = { protection: ForgeCredentialProtection; gap: string | null; bytes: Buffer }

export class ForgeCredentialUnavailableError extends Error {
  constructor() {
    super('forge inbox credential unavailable')
  }
}

function payloadOf(target: { instanceId: string; kind: string }, secret: string): string {
  return JSON.stringify({ instanceId: target.instanceId, kind: target.kind, secret })
}

function sealBeforeTransaction(
  store: SecretStore,
  payload: string,
  allowUnprotectedStorage: boolean
): Envelope | { refusedGap: string } {
  const available = store.isEncryptionAvailable()
  const reportedGap = store.describeProtectionGap()
  const gap = available ? reportedGap : (reportedGap ?? NO_ENCRYPTION_GAP)
  if (gap !== null && !allowUnprotectedStorage) {
    return { refusedGap: gap }
  }
  if (!available) {
    return { protection: 'plaintext', gap, bytes: Buffer.from(payload, 'utf8') }
  }
  return { protection: 'sealed', gap, bytes: store.encryptString(payload) }
}

export function setForgeCredential(
  ctx: ForgeLedgerContext,
  input: CredentialTarget & { secret: string; allowUnprotectedStorage?: boolean }
): ForgeCredentialWriteResult {
  const { secret } = input
  if (
    Buffer.byteLength(secret, 'utf8') > FORGE_CREDENTIAL_MAX_BYTES ||
    !VISIBLE_ASCII.test(secret)
  ) {
    return { ok: false, reason: 'invalid-secret' }
  }
  const sealed = sealBeforeTransaction(
    ctx.secretStore(),
    payloadOf(input, secret),
    input.allowUnprotectedStorage === true
  )
  if ('refusedGap' in sealed) {
    return { ok: false, reason: 'unprotected-storage', gap: sealed.refusedGap }
  }
  return runForgeTransaction(ctx.db, (): ForgeCredentialWriteResult => {
    const state = readForgeConfigState(ctx)
    if (state.revision !== input.expectedRevision) {
      return { ok: false, reason: 'stale-revision', configRevision: state.revision }
    }
    if (!state.config.instances.some((instance) => instance.id === input.instanceId)) {
      return { ok: false, reason: 'unknown-instance' }
    }
    ctx.db
      .prepare(
        `INSERT INTO credentials (instance_id, kind, protection, gap, envelope, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (instance_id, kind) DO UPDATE SET protection = excluded.protection,
           gap = excluded.gap, envelope = excluded.envelope, updated_at = excluded.updated_at`
      )
      .run(input.instanceId, input.kind, sealed.protection, sealed.gap, sealed.bytes, ctx.now())
    const configRevision = bumpForgeConfigRevision(ctx, state.revision)
    invalidateForgeInstancePolicies(ctx, new Set([input.instanceId]), [state.config])
    if (input.kind === 'api-read') {
      // Same transaction: a crash can never leave a fresh token beside parked deliveries.
      requeueForgeWebhookNeedsAuth(ctx, input.instanceId)
    }
    return { ok: true, configRevision, protection: sealed.protection }
  })
}

export function clearForgeCredential(
  ctx: ForgeLedgerContext,
  input: CredentialTarget
): ForgeCredentialWriteResult {
  return runForgeTransaction(ctx.db, (): ForgeCredentialWriteResult => {
    const state = readForgeConfigState(ctx)
    if (state.revision !== input.expectedRevision) {
      return { ok: false, reason: 'stale-revision', configRevision: state.revision }
    }
    if (!state.config.instances.some((instance) => instance.id === input.instanceId)) {
      return { ok: false, reason: 'unknown-instance' }
    }
    const removed = ctx.db
      .prepare('DELETE FROM credentials WHERE instance_id = ? AND kind = ?')
      .run(input.instanceId, input.kind)
    if (removed.changes === 0) {
      return { ok: true, configRevision: state.revision, protection: null }
    }
    const configRevision = bumpForgeConfigRevision(ctx, state.revision)
    invalidateForgeInstancePolicies(ctx, new Set([input.instanceId]), [state.config])
    return { ok: true, configRevision, protection: null }
  })
}

/** Host-private: for the trusted ingress and API broker only; there is deliberately no RPC for it. */
export function readForgeSecret(
  ctx: ForgeLedgerContext,
  instanceId: string,
  kind: ForgeCredentialKind
): ForgeRevealedSecret | null {
  const { config } = readForgeConfigState(ctx)
  if (!config.instances.some((instance) => instance.id === instanceId)) {
    return null
  }
  const row = ctx.db
    .prepare('SELECT protection, gap, envelope FROM credentials WHERE instance_id = ? AND kind = ?')
    .get(instanceId, kind)
  if (!row) {
    return null
  }
  const protection = rowText(row, 'protection')
  const gap = row.gap === null ? null : rowText(row, 'gap')
  try {
    if (
      (protection !== 'sealed' && protection !== 'plaintext') ||
      !(row.envelope instanceof Uint8Array)
    ) {
      throw new ForgeCredentialUnavailableError()
    }
    const bytes = Buffer.from(row.envelope)
    let payload: string
    if (protection === 'sealed') {
      const store = ctx.secretStore()
      if (!store.isEncryptionAvailable()) {
        throw new ForgeCredentialUnavailableError()
      }
      payload = store.decryptString(bytes)
    } else {
      payload = bytes.toString('utf8')
    }
    const parsed: unknown = JSON.parse(payload)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('instanceId' in parsed) ||
      !('kind' in parsed) ||
      !('secret' in parsed) ||
      parsed.instanceId !== instanceId ||
      parsed.kind !== kind ||
      typeof parsed.secret !== 'string' ||
      !VISIBLE_ASCII.test(parsed.secret) ||
      Buffer.byteLength(parsed.secret, 'utf8') > FORGE_CREDENTIAL_MAX_BYTES
    ) {
      throw new ForgeCredentialUnavailableError()
    }
    return { secret: parsed.secret, protection, gap }
  } catch {
    throw new ForgeCredentialUnavailableError()
  }
}

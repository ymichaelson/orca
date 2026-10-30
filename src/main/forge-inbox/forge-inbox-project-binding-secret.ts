import { FORGE_CREDENTIAL_MAX_BYTES } from '../../shared/forge-inbox-config'
import type { ProjectEventBindingSecretProtection } from '../../shared/forge-inbox-project-binding'
import type { SecretStore } from '../../shared/secret-store'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { rowText } from './forge-inbox-rows'

const VISIBLE_ASCII = /^[\x21-\x7e]+$/
const NO_ENCRYPTION_GAP = 'encryption is unavailable on this host'

/** How long a rotated-out secret still admits callbacks GitLab sent before the remote switched. */
export const PROJECT_BINDING_PREVIOUS_SECRET_TTL_MS = 5 * 60_000

export type ProjectBindingSecretResult =
  | { ok: true; protection: ProjectEventBindingSecretProtection }
  | { ok: false; reason: 'unknown-binding' | 'invalid-secret' | 'already-staged' }
  | { ok: false; reason: 'unprotected-storage'; gap: string }

export type ProjectBindingRevealedSecret = {
  secret: string
  protection: ProjectEventBindingSecretProtection
  gap: string | null
}

export class ProjectBindingSecretUnavailableError extends Error {
  constructor() {
    super('project binding secret unavailable')
  }
}

type Envelope = {
  protection: ProjectEventBindingSecretProtection
  gap: string | null
  bytes: Buffer
}

function payloadOf(bindingId: string, secret: string): string {
  return JSON.stringify({ bindingId, secret })
}

function sealProjectBindingSecret(
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

export function setProjectBindingSecret(
  ctx: ForgeLedgerContext,
  input: { bindingId: string; secret: string; allowUnprotectedStorage?: boolean }
): ProjectBindingSecretResult {
  const { bindingId, secret } = input
  if (
    Buffer.byteLength(secret, 'utf8') > FORGE_CREDENTIAL_MAX_BYTES ||
    !VISIBLE_ASCII.test(secret)
  ) {
    return { ok: false, reason: 'invalid-secret' }
  }
  const sealed = sealProjectBindingSecret(
    ctx.secretStore(),
    payloadOf(bindingId, secret),
    input.allowUnprotectedStorage === true
  )
  if ('refusedGap' in sealed) {
    return { ok: false, reason: 'unprotected-storage', gap: sealed.refusedGap }
  }
  return runForgeTransaction(ctx.db, (): ProjectBindingSecretResult => {
    const exists = ctx.db
      .prepare('SELECT 1 AS found FROM project_bindings WHERE binding_id = ?')
      .get(bindingId)
    if (!exists) {
      return { ok: false, reason: 'unknown-binding' }
    }
    ctx.db
      .prepare(
        `UPDATE project_bindings SET secret_protection = ?, secret_gap = ?, secret_envelope = ?,
           previous_secret_protection = NULL, previous_secret_gap = NULL,
           previous_secret_envelope = NULL, previous_secret_expires_at = NULL,
           updated_at = ? WHERE binding_id = ?`
      )
      .run(sealed.protection, sealed.gap, sealed.bytes, ctx.now(), bindingId)
    return { ok: true, protection: sealed.protection }
  })
}

/** Stages a rotation without touching the active secret, so a crash never leaves two live secrets. */
export function stageProjectBindingSecretRotation(
  ctx: ForgeLedgerContext,
  input: { bindingId: string; secret: string; allowUnprotectedStorage?: boolean }
): ProjectBindingSecretResult {
  const { bindingId, secret } = input
  if (
    Buffer.byteLength(secret, 'utf8') > FORGE_CREDENTIAL_MAX_BYTES ||
    !VISIBLE_ASCII.test(secret)
  ) {
    return { ok: false, reason: 'invalid-secret' }
  }
  const sealed = sealProjectBindingSecret(
    ctx.secretStore(),
    payloadOf(bindingId, secret),
    input.allowUnprotectedStorage === true
  )
  if ('refusedGap' in sealed) {
    return { ok: false, reason: 'unprotected-storage', gap: sealed.refusedGap }
  }
  return runForgeTransaction(ctx.db, (): ProjectBindingSecretResult => {
    const exists = ctx.db
      .prepare('SELECT 1 AS found FROM project_bindings WHERE binding_id = ?')
      .get(bindingId)
    if (!exists) {
      return { ok: false, reason: 'unknown-binding' }
    }
    const staged = ctx.db
      .prepare(
        `UPDATE project_bindings SET pending_secret_protection = ?, pending_secret_gap = ?,
           pending_secret_envelope = ?, updated_at = ?
         WHERE binding_id = ? AND pending_secret_envelope IS NULL`
      )
      .run(sealed.protection, sealed.gap, sealed.bytes, ctx.now(), bindingId)
    if (staged.changes === 0) {
      return { ok: false, reason: 'already-staged' }
    }
    return { ok: true, protection: sealed.protection }
  })
}

/** Promotes the staged envelope only after the remote accepted it; returns null when none is pending. */
export function promoteProjectBindingSecretRotation(
  ctx: ForgeLedgerContext,
  bindingId: string
): ProjectEventBindingSecretProtection | null {
  return runForgeTransaction(ctx.db, () => {
    const row = ctx.db
      .prepare(
        `SELECT pending_secret_protection, pending_secret_gap, pending_secret_envelope
         FROM project_bindings WHERE binding_id = ?`
      )
      .get(bindingId)
    if (!row || row.pending_secret_envelope === null) {
      return null
    }
    const protection =
      row.pending_secret_protection === 'sealed' || row.pending_secret_protection === 'plaintext'
        ? row.pending_secret_protection
        : null
    if (protection === null) {
      throw new ProjectBindingSecretUnavailableError()
    }
    ctx.db
      .prepare(
        `UPDATE project_bindings SET
           previous_secret_protection = CASE WHEN secret_envelope IS NULL THEN NULL ELSE secret_protection END,
           previous_secret_gap = CASE WHEN secret_envelope IS NULL THEN NULL ELSE secret_gap END,
           previous_secret_envelope = secret_envelope,
           previous_secret_expires_at = CASE WHEN secret_envelope IS NULL THEN NULL ELSE ? END,
           secret_protection = ?, secret_gap = ?, secret_envelope = ?,
           pending_secret_protection = NULL, pending_secret_gap = NULL,
           pending_secret_envelope = NULL, updated_at = ? WHERE binding_id = ?`
      )
      .run(
        ctx.now() + PROJECT_BINDING_PREVIOUS_SECRET_TTL_MS,
        protection,
        row.pending_secret_gap,
        row.pending_secret_envelope,
        ctx.now(),
        bindingId
      )
    return protection
  })
}

/** Drops a staged envelope the remote never confirmed, so it can never become active. */
export function clearProjectBindingSecretRotation(
  ctx: ForgeLedgerContext,
  bindingId: string
): void {
  runForgeTransaction(ctx.db, () => {
    ctx.db
      .prepare(
        `UPDATE project_bindings SET pending_secret_protection = NULL, pending_secret_gap = NULL,
           pending_secret_envelope = NULL, updated_at = ? WHERE binding_id = ?`
      )
      .run(ctx.now(), bindingId)
  })
}

/** An unreadable candidate may already be live remotely, so reading must preserve its envelope. */
export function readProjectBindingPendingSecret(
  ctx: ForgeLedgerContext,
  bindingId: string
): string | null {
  const row = ctx.db
    .prepare(
      `SELECT pending_secret_protection, pending_secret_gap, pending_secret_envelope
       FROM project_bindings WHERE binding_id = ?`
    )
    .get(bindingId)
  if (!row || row.pending_secret_envelope === null) {
    return null
  }
  const { protection, gap } = protectedColumns(
    row.pending_secret_protection,
    row.pending_secret_gap
  )
  return revealSecret(ctx, bindingId, protection, gap, row.pending_secret_envelope).secret
}

function revealSecret(
  ctx: ForgeLedgerContext,
  bindingId: string,
  protection: ProjectEventBindingSecretProtection,
  gap: string | null,
  envelope: unknown
): ProjectBindingRevealedSecret {
  try {
    if (!(envelope instanceof Uint8Array)) {
      throw new ProjectBindingSecretUnavailableError()
    }
    const bytes = Buffer.from(envelope)
    let payload: string
    if (protection === 'sealed') {
      const store = ctx.secretStore()
      if (!store.isEncryptionAvailable()) {
        throw new ProjectBindingSecretUnavailableError()
      }
      payload = store.decryptString(bytes)
    } else {
      payload = bytes.toString('utf8')
    }
    const parsed: unknown = JSON.parse(payload)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('bindingId' in parsed) ||
      !('secret' in parsed) ||
      parsed.bindingId !== bindingId ||
      typeof parsed.secret !== 'string' ||
      !VISIBLE_ASCII.test(parsed.secret) ||
      Buffer.byteLength(parsed.secret, 'utf8') > FORGE_CREDENTIAL_MAX_BYTES
    ) {
      throw new ProjectBindingSecretUnavailableError()
    }
    return { secret: parsed.secret, protection, gap }
  } catch {
    throw new ProjectBindingSecretUnavailableError()
  }
}

function clearPreviousSecret(ctx: ForgeLedgerContext, bindingId: string): void {
  ctx.db
    .prepare(
      `UPDATE project_bindings SET previous_secret_protection = NULL, previous_secret_gap = NULL,
         previous_secret_envelope = NULL, previous_secret_expires_at = NULL WHERE binding_id = ?`
    )
    .run(bindingId)
}

function protectedColumns(
  protection: unknown,
  gap: unknown
): { protection: ProjectEventBindingSecretProtection; gap: string | null } {
  if (protection !== 'sealed' && protection !== 'plaintext') {
    throw new ProjectBindingSecretUnavailableError()
  }
  return { protection, gap: typeof gap === 'string' ? gap : null }
}

/** Host-private: for the trusted hook broker only; there is deliberately no RPC for it. */
export function readProjectBindingSecret(
  ctx: ForgeLedgerContext,
  bindingId: string
): ProjectBindingRevealedSecret | null {
  const row = ctx.db
    .prepare(
      'SELECT secret_protection, secret_gap, secret_envelope FROM project_bindings WHERE binding_id = ?'
    )
    .get(bindingId)
  if (!row || row.secret_envelope === null) {
    return null
  }
  const columns = protectedColumns(
    row.secret_protection === null ? null : rowText(row, 'secret_protection'),
    row.secret_gap === null ? null : rowText(row, 'secret_gap')
  )
  return revealSecret(ctx, bindingId, columns.protection, columns.gap, row.secret_envelope)
}

/**
 * The retired secret only authenticates inside the stored window; reading past it clears the
 * columns so a restart cannot revive a secret the remote already replaced.
 */
export function readProjectBindingPreviousSecret(
  ctx: ForgeLedgerContext,
  bindingId: string
): ProjectBindingRevealedSecret | null {
  const row = ctx.db
    .prepare(
      `SELECT previous_secret_protection, previous_secret_gap, previous_secret_envelope,
         previous_secret_expires_at FROM project_bindings WHERE binding_id = ?`
    )
    .get(bindingId)
  if (!row || row.previous_secret_envelope === null) {
    return null
  }
  const expiresAt = row.previous_secret_expires_at
  if (typeof expiresAt !== 'number' || expiresAt <= ctx.now()) {
    clearPreviousSecret(ctx, bindingId)
    return null
  }
  const columns = protectedColumns(
    row.previous_secret_protection === null ? null : rowText(row, 'previous_secret_protection'),
    row.previous_secret_gap === null ? null : rowText(row, 'previous_secret_gap')
  )
  return revealSecret(ctx, bindingId, columns.protection, columns.gap, row.previous_secret_envelope)
}

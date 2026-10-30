import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ProjectEventBindingState } from '../../shared/forge-inbox-project-binding'
import { setProjectBindingProgress, upsertProjectBinding } from './forge-inbox-project-binding'
import {
  readProjectBindingSecret,
  setProjectBindingSecret
} from './forge-inbox-project-binding-secret'
import { fakeSecretStore } from './forge-inbox-webhook-test-harness'

const store = fakeSecretStore()

function seedBinding(dbPath: string, state: ProjectEventBindingState = 'verifying'): string {
  const { db, hostId } = openForgeInboxDatabase(dbPath)
  const ctx: ForgeLedgerContext = {
    db,
    hostId,
    now: () => 1_000,
    secretStore: () => store
  }
  try {
    const binding = upsertProjectBinding(ctx, {
      bindingId: randomUUID(),
      projectPath: '/work/repo',
      gitlabHost: 'gitlab.test:8929',
      gitlabPath: 'group/demo',
      gitlabProjectId: 12,
      callbackUrl: 'https://orca.example.com/project-events/callback'
    })
    setProjectBindingSecret(ctx, { bindingId: binding.bindingId, secret: 'seeded-secret' })
    setProjectBindingProgress(ctx, binding.bindingId, {
      state,
      hookId: 7,
      rejectedEvents: ['push'],
      ...(state === 'failed'
        ? { failure: { phase: 'registering', code: 'network', retryable: true } }
        : {})
    })
    return binding.bindingId
  } finally {
    db.close()
  }
}

function readBindingRow(dbPath: string, bindingId: string): Record<string, unknown> {
  const { db } = openForgeInboxDatabase(dbPath)
  try {
    const row = db
      .prepare(
        `SELECT state, failure_phase, failure_code, failed_at, retryable, updated_at, hook_id
         FROM project_bindings WHERE binding_id = ?`
      )
      .get(bindingId)
    if (row === undefined) {
      throw new Error(`project binding ${bindingId} does not exist`)
    }
    return row
  } finally {
    db.close()
  }
}

describe('project binding restart recovery', () => {
  let root: string | undefined

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true })
      root = undefined
    }
  })

  it('reports a verifying binding left by a dead process as retryable failed on open', () => {
    root = mkdtempSync(join(tmpdir(), 'forge-binding-recovery-'))
    const dbPath = join(root, 'forge-inbox.sqlite')
    const bindingId = seedBinding(dbPath)

    ForgeInboxLedger.open(dbPath, { now: () => 5_000, secretStore: store }).close()
    expect(readBindingRow(dbPath, bindingId)).toMatchObject({
      state: 'failed',
      failure_phase: 'verifying',
      failure_code: 'interrupted',
      failed_at: 5_000,
      retryable: 1,
      updated_at: 5_000,
      hook_id: 7
    })

    ForgeInboxLedger.open(dbPath, { now: () => 9_000, secretStore: store }).close()
    expect(readBindingRow(dbPath, bindingId)).toMatchObject({
      state: 'failed',
      failure_code: 'interrupted',
      failed_at: 5_000,
      updated_at: 5_000
    })
  })

  it.each(['checking', 'registering', 'verifying'] as const)(
    'fails a %s binding on open keeping its phase, hook and secret',
    (state) => {
      root = mkdtempSync(join(tmpdir(), 'forge-binding-recovery-'))
      const dbPath = join(root, 'forge-inbox.sqlite')
      const bindingId = seedBinding(dbPath, state)

      const ledger = ForgeInboxLedger.open(dbPath, {
        now: () => 5_000,
        secretStore: store
      })
      const secret = readProjectBindingSecret(ledger.ledgerContext(), bindingId)?.secret
      ledger.close()

      expect(readBindingRow(dbPath, bindingId)).toMatchObject({
        state: 'failed',
        failure_phase: state,
        failure_code: 'interrupted',
        retryable: 1,
        hook_id: 7
      })
      expect(secret).toBe('seeded-secret')
    }
  )

  it.each(['connected', 'failed', 'unconfigured'] as const)(
    'leaves a %s binding untouched on open',
    (state) => {
      root = mkdtempSync(join(tmpdir(), 'forge-binding-recovery-'))
      const dbPath = join(root, 'forge-inbox.sqlite')
      const bindingId = seedBinding(dbPath, state)
      const before = readBindingRow(dbPath, bindingId)

      ForgeInboxLedger.open(dbPath, { now: () => 5_000, secretStore: store }).close()

      expect(readBindingRow(dbPath, bindingId)).toEqual(before)
    }
  )
})

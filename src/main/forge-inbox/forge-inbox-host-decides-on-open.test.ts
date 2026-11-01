import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { startForgeInboxForHost } from './forge-inbox-host-startup'
import type { ForgeInboxOwnerService } from './forge-inbox-owner-service'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { PROJECT_EVENT_BINDING_ID } from './forge-inbox-owner-fixture-binding'
import { setProjectBindingSecret } from './forge-inbox-project-binding-secret'
import { fakeSecretStore, WEBHOOK_TOKEN } from './forge-inbox-webhook-test-harness'

type SecretStore = ReturnType<typeof fakeSecretStore>

/** One delivered when the inbox opens, as a quit before its decision would leave it. */
function admitDeliveredPush(dbPath: string, secretStore: SecretStore): void {
  const ledger = ForgeInboxLedger.open(dbPath, { secretStore })
  try {
    const ctx = ledger.ledgerContext()
    upsertProjectBinding(ctx, {
      bindingId: PROJECT_EVENT_BINDING_ID,
      projectPath: '/repo',
      gitlabHost: 'gitlab.example.com',
      gitlabPath: 'group/demo',
      gitlabProjectId: 42,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${PROJECT_EVENT_BINDING_ID}`
    })
    const stored = setProjectBindingSecret(ctx, {
      bindingId: PROJECT_EVENT_BINDING_ID,
      secret: WEBHOOK_TOKEN
    })
    if (!stored.ok) {
      throw new Error('fixture could not store the binding secret')
    }
    // An unlinked binding is what the owner retries, so the link already exists when the process quits.
    ctx.db
      .prepare(
        `INSERT INTO project_event_repo_links (host_id, repo_id, binding_id, created_at)
         VALUES (?, 'repo-1', ?, ?)`
      )
      .run(ctx.hostId, PROJECT_EVENT_BINDING_ID, ctx.now())
    ctx.db
      .prepare(
        `INSERT INTO webhook_deliveries (host_id, binding_id, project_id, dedupe_key, event_kind,
          event_uuid, config_uuid, policy_generation, admitted_at, state, parked_reason,
          finished_at, body, decision_state)
         VALUES (?, ?, 'group/demo', 'push-1', 'Push Hook', NULL, NULL, NULL, ?, 'pending',
           'recorded', NULL, ?, 'queued')`
      )
      .run(
        ctx.hostId,
        PROJECT_EVENT_BINDING_ID,
        ctx.now(),
        Buffer.from(
          JSON.stringify({
            object_kind: 'push',
            project: { id: 42, path_with_namespace: 'group/demo' },
            ref: 'refs/heads/main',
            before: '0'.repeat(40),
            after: 'a'.repeat(40),
            commits: []
          })
        )
      )
  } finally {
    ledger.close()
  }
}

const rows = (dbPath: string, sql: string): unknown[] => {
  const ledger = ForgeInboxLedger.open(dbPath)
  try {
    return ledger.ledgerContext().db.prepare(sql).all()
  } finally {
    ledger.close()
  }
}

describe('forge inbox host startup work left by an earlier process', () => {
  const roots: string[] = []
  const started: ForgeInboxOwnerService[] = []
  afterEach(async () => {
    for (const service of started.splice(0)) {
      await service.stop()
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function profile(): { root: string; dbPath: string; secretStore: SecretStore } {
    const root = mkdtempSync(join(tmpdir(), 'forge-host-open-'))
    roots.push(root)
    return { root, dbPath: join(root, 'forge-inbox.db'), secretStore: fakeSecretStore() }
  }

  it('decides a delivery already in the ledger as soon as the owner opens', async () => {
    const fx = profile()
    admitDeliveredPush(fx.dbPath, fx.secretStore)

    await startForgeInboxForHost({
      profileDirectory: fx.root,
      secretStore: fx.secretStore,
      http: {
        fetch: async () => {
          throw new Error('a repository without a policy has nothing to decide')
        }
      },
      networkReady: Promise.resolve(),
      notify: () => undefined,
      decisionSource: {
        read: () => ({ settings: { provider: 'jev', model: '', baseUrl: '' }, apiKey: 'key' })
      },
      attach: (service) => {
        started.push(service)
      }
    })
    await started[0]!.settled()

    expect(
      rows(fx.dbPath, 'SELECT state, decision_state, parked_reason FROM webhook_deliveries')
    ).toEqual([{ state: 'pending', decision_state: 'decided', parked_reason: 'recorded' }])
    expect(rows(fx.dbPath, 'SELECT kind, iid, project_id FROM items')).toEqual([
      { kind: 'project', iid: -1, project_id: 'group/demo' }
    ])
  })

  it('keeps the machine awake for a question left open by an earlier process', async () => {
    const fx = profile()
    admitDeliveredPush(fx.dbPath, fx.secretStore)
    const held: string[] = []
    const openQuestionHold = {
      acquireExternalHold: (reason: string) => {
        held.push(reason)
        return { release: () => held.splice(held.indexOf(reason), 1) }
      }
    }

    await startForgeInboxForHost({
      profileDirectory: fx.root,
      secretStore: fx.secretStore,
      http: {
        fetch: async () => {
          throw new Error('a repository without a policy has nothing to decide')
        }
      },
      networkReady: Promise.resolve(),
      notify: () => undefined,
      openQuestionHold,
      decisionSource: {
        read: () => ({ settings: { provider: 'jev', model: '', baseUrl: '' }, apiKey: 'key' })
      },
      attach: (service) => {
        started.push(service)
      }
    })
    await started[0]!.settled()
    // The hold is refreshed explicitly, since its own tick does not keep a test process alive.
    started[0]!.refreshOpenQuestionHold()

    expect(rows(fx.dbPath, 'SELECT status FROM project_event_questions')).toEqual([
      { status: 'open' }
    ])
    expect(held).toEqual(['forge-inbox:open-question'])
  })
})

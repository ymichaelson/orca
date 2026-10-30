import type { SecretStore } from '../../shared/secret-store'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { setProjectBindingProgress, upsertProjectBinding } from './forge-inbox-project-binding'
import { setProjectBindingSecret } from './forge-inbox-project-binding-secret'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { PROJECT_ID, WEBHOOK_TOKEN } from './forge-inbox-webhook-test-harness'

export const PROJECT_EVENT_BINDING_ID = '11111111-1111-4111-8111-111111111111'
export const HOOK_PATH = `/webhooks/gitlab/${PROJECT_EVENT_BINDING_ID}`

/** One connected binding per fixture database, so callbacks authenticate without an instance token. */
export function ensureOwnerFixtureBinding(dbPath: string, secretStore: SecretStore): void {
  const ledger = ForgeInboxLedger.open(dbPath, { secretStore })
  try {
    const ctx = ledger.ledgerContext()
    const bindingId = PROJECT_EVENT_BINDING_ID
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: '/repo',
      gitlabHost: 'gitlab.example.com',
      gitlabPath: 'group/demo',
      gitlabProjectId: Number(PROJECT_ID),
      callbackUrl: `https://orca.example.com${HOOK_PATH}`
    })
    const stored = setProjectBindingSecret(ctx, { bindingId, secret: WEBHOOK_TOKEN })
    if (!stored.ok) {
      throw new Error(`fixture could not store the binding secret: ${stored.reason}`)
    }
    linkProjectEventBinding(ctx, { repoId: 'repo-1', bindingId })
    updateProjectEventPolicy(ctx, {
      repoId: 'repo-1',
      expectedGeneration: 0,
      patch: { enabled: true, agentId: 'claude' }
    })
    setProjectBindingProgress(ctx, bindingId, { state: 'connected', hookId: 7 })
  } finally {
    ledger.close()
  }
}

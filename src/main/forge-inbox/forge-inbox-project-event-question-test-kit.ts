import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ProjectEventDecisionAction,
  ProjectEventDecisionResult
} from '../../shared/project-event-decision'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'

export const PROJECT_EVENT_TEST_REPO_ID = 'repo-1'
export const PROJECT_EVENT_TEST_TITLE = 'Add thing'

export function projectEventQuestionBody(title = PROJECT_EVENT_TEST_TITLE): Buffer {
  return Buffer.from(
    JSON.stringify({
      object_kind: 'merge_request',
      project: { id: 3, path_with_namespace: 'group/demo' },
      merge_request: { iid: 7, title, state: 'opened' },
      object_attributes: { action: 'update', last_commit: { id: 'sha-1' } }
    })
  )
}

export function projectEventQuestionDecision(
  action: ProjectEventDecisionAction
): ProjectEventDecisionResult {
  return {
    ok: true,
    provider: 'jev',
    model: 'jev-1',
    action,
    confidence: 0.8,
    probabilities: {
      record_only: 0.04,
      notify: 0.04,
      wait: 0.04,
      fetch_context: 0.04,
      dispatch_agent: 0.04,
      ask_user: 0.8
    },
    usage: { inputTokens: 10, outputTokens: 2 }
  }
}

/** Binds one repo to a fresh binding under an enabled policy, the state every question round needs. */
export function seedProjectEventQuestionPolicy(ctx: ForgeLedgerContext, rules = 'rules'): string {
  const bindingId = randomUUID()
  upsertProjectBinding(ctx, {
    bindingId,
    projectPath: '/repo',
    gitlabHost: 'gitlab.test',
    gitlabPath: 'group/demo',
    gitlabProjectId: 3,
    callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
  })
  linkProjectEventBinding(ctx, { repoId: PROJECT_EVENT_TEST_REPO_ID, bindingId })
  updateProjectEventPolicy(ctx, {
    repoId: PROJECT_EVENT_TEST_REPO_ID,
    expectedGeneration: 0,
    patch: { enabled: true, agentId: 'claude', model: 'claude-sonnet-5-5', rules }
  })
  return bindingId
}

export type ProjectEventQuestionFixture = {
  root: string
  ledger: ForgeInboxLedger
  ctx: ForgeLedgerContext
  bindingId: string
  close(): void
}

export function openProjectEventQuestionFixture(prefix: string): ProjectEventQuestionFixture {
  const root = mkdtempSync(join(tmpdir(), prefix))
  let clock = 1000
  const ledger = ForgeInboxLedger.open(join(root, 'forge-inbox.sqlite'), {
    hostId: 'host-1',
    now: () => ++clock,
    secretStore: fakeStore()
  })
  const ctx = ledger.ledgerContext()
  const bindingId = seedProjectEventQuestionPolicy(ctx)
  return {
    root,
    ledger,
    ctx,
    bindingId,
    close: () => {
      ledger.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

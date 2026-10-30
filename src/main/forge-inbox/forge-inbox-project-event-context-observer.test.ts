import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  ProjectEventDecisionAction,
  ProjectEventDecisionResult
} from '../../shared/project-event-decision'
import type { GlabExecOptions } from '../git/command-runner/glab-exec-file'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import {
  drainProjectEventActions,
  type ProjectEventActionDeps
} from './forge-inbox-project-event-action-drain'
import type { ProjectEventActionClaim } from './forge-inbox-project-event-action'
import { createForgeProjectEventContextObserver } from './forge-inbox-project-event-context-observer'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { isRecord, rowText } from './forge-inbox-rows'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

const REPO_ID = 'repo-1'
const GITLAB_HOST = 'gitlab.test'
const GITLAB_PROJECT_ID = 3
const PROJECT_PATH = 'group/demo'
const RULES = '合并请求需要评审。'
const OBSERVED_SHA = 'a'.repeat(40)

const MR_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'merge_request',
    project: { id: GITLAB_PROJECT_ID },
    merge_request: { iid: 7, title: 'Add thing', state: 'opened' },
    object_attributes: { action: 'update', last_commit: { id: 'sha-1' } }
  })
)

type Exec = (
  args: string[],
  options?: GlabExecOptions
) => Promise<{ stdout: string; stderr: string }>

const mergeRequest = {
  iid: 7,
  state: 'opened',
  title: 'Add thing',
  description: 'Explains the fix',
  target_branch: 'main',
  source_branch: 'feat',
  draft: false,
  sha: OBSERVED_SHA,
  diff_refs: { base_sha: 'b'.repeat(40), head_sha: OBSERVED_SHA, start_sha: 'd'.repeat(40) },
  author: { username: 'alice' },
  reviewers: [],
  assignees: [],
  updated_at: '2026-10-01T10:00:00.000Z'
}
const note = {
  id: 1,
  system: false,
  author: { username: 'alice' },
  body: 'note 1',
  updated_at: '2026-10-01T10:00:00.000Z'
}
const diff = {
  old_path: 'src/a.ts',
  new_path: 'src/a.ts',
  diff: '@@ -1 +1 @@\n-a\n+b\n',
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  generated_file: false
}

function glabResponse(body: unknown): string {
  return `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}`
}

function fakeGlab(): { calls: number; exec: Exec } {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    exec: async (args) => {
      calls += 1
      const route = args[4]
      if (route === `projects/${GITLAB_PROJECT_ID}/merge_requests/7`) {
        return { stdout: glabResponse(mergeRequest), stderr: '' }
      }
      if (route?.startsWith(`projects/${GITLAB_PROJECT_ID}/merge_requests/7/notes?`)) {
        return { stdout: glabResponse([note]), stderr: '' }
      }
      if (route?.startsWith(`projects/${GITLAB_PROJECT_ID}/merge_requests/7/diffs?`)) {
        return { stdout: glabResponse([diff]), stderr: '' }
      }
      throw new Error(`unexpected glab route ${route}`)
    }
  }
}

const unauthorizedExec: Exec = async () => {
  throw Object.assign(new Error('glab failed'), {
    stderr: 'glab: 401 Unauthorized (HTTP 401)'
  })
}

const decision = (action: ProjectEventDecisionAction): ProjectEventDecisionResult => ({
  ok: true,
  provider: 'jev',
  model: 'jev-1',
  action,
  confidence: 0.8,
  probabilities: {
    record_only: action === 'record_only' ? 0.8 : 0.04,
    notify: action === 'notify' ? 0.8 : 0.04,
    wait: action === 'wait' ? 0.8 : 0.04,
    fetch_context: action === 'fetch_context' ? 0.8 : 0.04,
    dispatch_agent: action === 'dispatch_agent' ? 0.8 : 0.04,
    ask_user: action === 'ask_user' ? 0.8 : 0.04
  },
  usage: { inputTokens: 10, outputTokens: 2 }
})

describe('project event context observer', () => {
  let root: string
  let ledger: ForgeInboxLedger
  let ctx: ForgeLedgerContext
  let bindingId: string
  let clock: number
  let deliveries: number

  function recordFetchContext(): void {
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: PROJECT_PATH,
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Merge Request Hook',
      dedupeKey: `delivery-${deliveries++}`,
      correlation: { eventUuid: null, configUuid: null },
      body: MR_BODY
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }
    const claim = claimProjectEventDecision(ctx)
    if (!claim) {
      throw new Error('expected a project event decision claim')
    }
    if (
      !decideProjectEventDelivery(ctx, admitted.deliveryId, decision('fetch_context'), claim).ok
    ) {
      throw new Error('fixture could not record the decision')
    }
  }

  function deps(exec: Exec): ProjectEventActionDeps {
    return {
      observeContext: createForgeProjectEventContextObserver(ledger, exec),
      limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS
    }
  }

  function actionClaim(): ProjectEventActionClaim {
    return {
      decisionId: 1,
      deliveryId: 1,
      action: 'fetch_context',
      itemId: null,
      token: 'token',
      startedAt: 1,
      bindingId,
      repoId: REPO_ID,
      generation: 1
    }
  }

  function decisionRow() {
    return ctx.db
      .prepare('SELECT action_state, last_error_code FROM project_event_decisions WHERE id = 1')
      .get()
  }

  function deliveryRow() {
    return ctx.db
      .prepare(`SELECT state, decision_state, last_error_code FROM webhook_deliveries WHERE id = 1`)
      .get()
  }

  function pendingDeliveries() {
    return ctx.db
      .prepare(
        `SELECT id, dedupe_key, body FROM webhook_deliveries WHERE state = 'pending' ORDER BY id`
      )
      .all()
  }

  function bodyObject(body: unknown): Record<string, unknown> {
    if (!(body instanceof Uint8Array)) {
      throw new Error('expected a binary delivery body')
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
    if (!isRecord(parsed)) {
      throw new Error('expected a JSON object delivery body')
    }
    return parsed
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-context-observer-'))
    clock = 1000
    deliveries = 0
    ledger = ForgeInboxLedger.open(join(root, 'forge-inbox.sqlite'), {
      hostId: 'host-1',
      now: () => ++clock,
      secretStore: fakeStore()
    })
    ctx = ledger.ledgerContext()
    bindingId = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: '/repo',
      gitlabHost: GITLAB_HOST,
      gitlabPath: PROJECT_PATH,
      gitlabProjectId: GITLAB_PROJECT_ID,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
    })
    linkProjectEventBinding(ctx, { repoId: REPO_ID, bindingId })
    updateProjectEventPolicy(ctx, {
      repoId: REPO_ID,
      expectedGeneration: 0,
      patch: { enabled: true, rules: RULES }
    })
  })

  afterEach(() => {
    ledger.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('fetches one observed head and synthesizes the next decision delivery', async () => {
    recordFetchContext()
    const glab = fakeGlab()

    expect(await drainProjectEventActions(ctx, deps(glab.exec))).toEqual({
      executed: 1,
      failed: 0,
      capped: false
    })

    expect(glab.calls).toBe(4)
    expect(decisionRow()).toMatchObject({ action_state: 'done', last_error_code: null })
    expect(deliveryRow()).toMatchObject({ state: 'done', decision_state: 'decided' })
    const pending = pendingDeliveries()
    expect(pending).toHaveLength(1)
    const synthesized = pending[0]
    if (!synthesized) {
      throw new Error('expected the synthesized delivery')
    }
    expect(rowText(synthesized, 'dedupe_key')).toMatch(/^context:1:1:sha256:[0-9a-f]+$/)
    expect(bodyObject(synthesized.body)).toMatchObject({
      object_kind: 'merge_request',
      context_round: 1,
      context_source: 'observation',
      object_attributes: { sha: OBSERVED_SHA }
    })
  })

  it('settles a rejected credential as a blocked action without a delivery', async () => {
    recordFetchContext()

    expect(
      await createForgeProjectEventContextObserver(ledger, unauthorizedExec)(actionClaim())
    ).toEqual({ ok: false, code: 'unauthorized' })
    expect(
      pendingDeliveries().filter((row) => rowText(row, 'dedupe_key').startsWith('context:'))
    ).toHaveLength(0)

    expect(await drainProjectEventActions(ctx, deps(unauthorizedExec))).toEqual({
      executed: 0,
      failed: 1,
      capped: false
    })

    expect(decisionRow()).toMatchObject({
      action_state: 'blocked',
      last_error_code: 'unauthorized'
    })
    expect(deliveryRow()).toMatchObject({ state: 'failed', last_error_code: 'unauthorized' })
    expect(pendingDeliveries()).toHaveLength(0)
  })

  it('forwards an aborted signal without reading glab', async () => {
    recordFetchContext()
    const glab = fakeGlab()
    const claim = actionClaim()
    const controller = new AbortController()
    controller.abort()

    expect(
      await createForgeProjectEventContextObserver(ledger, glab.exec)(claim, controller.signal)
    ).toEqual({ ok: false, code: 'aborted' })
    expect(glab.calls).toBe(0)
  })
})

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
import type { ProjectEventActionClaim } from './forge-inbox-project-event-action'
import {
  drainProjectEventActions,
  type ProjectEventActionDeps
} from './forge-inbox-project-event-action-drain'
import { createForgeProjectEventItemStateObserver } from './forge-inbox-project-event-item-state-observer'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { rowText } from './forge-inbox-rows'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

const GITLAB_HOST = 'gitlab.test'
const GITLAB_PROJECT_ID = 3
const PROJECT_PATH = 'group/demo'

type Exec = (
  args: string[],
  options?: GlabExecOptions
) => Promise<{ stdout: string; stderr: string }>

function glabResponse(body: unknown): string {
  return `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}`
}

const OBSERVED_SHA = 'a'.repeat(40)
const mergeRequest = {
  iid: 7,
  state: 'merged',
  title: 'Add thing',
  description: 'Explains the fix',
  target_branch: 'main',
  source_branch: 'feat',
  sha: OBSERVED_SHA,
  diff_refs: { base_sha: 'b'.repeat(40), head_sha: OBSERVED_SHA, start_sha: 'd'.repeat(40) },
  author: { username: 'alice' },
  reviewers: [],
  assignees: [],
  updated_at: '2026-10-01T10:00:00.000Z'
}

function mergeRequestBody(state: string, action: string, sha: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      object_kind: 'merge_request',
      project: { id: GITLAB_PROJECT_ID },
      merge_request: { iid: 7, title: 'Add thing', state },
      object_attributes: { action, last_commit: { id: sha } }
    })
  )
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

describe('project event item state observer', () => {
  let root: string
  let ledger: ForgeInboxLedger
  let ctx: ForgeLedgerContext
  let bindingId: string
  let deliveries: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-item-state-observer-'))
    let clock = 1000
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
    linkProjectEventBinding(ctx, { repoId: 'repo-1', bindingId })
    updateProjectEventPolicy(ctx, {
      repoId: 'repo-1',
      expectedGeneration: 0,
      patch: { enabled: true, rules: '合并请求需要评审。' }
    })
  })

  afterEach(() => {
    ledger.close()
    rmSync(root, { recursive: true, force: true })
  })

  function claim(itemId: number | null): ProjectEventActionClaim {
    return {
      decisionId: 1,
      deliveryId: 1,
      action: 'fetch_context',
      itemId,
      token: 'token',
      startedAt: 1,
      bindingId,
      repoId: 'repo-1',
      generation: 1
    }
  }

  function seedMergeRequestItem(): void {
    ctx.db
      .prepare(
        `INSERT INTO items (host_id, instance_id, project_id, kind, iid, title, state,
           current_revision, head_order, activity_seq, created_at, updated_at)
         VALUES (?, 'gitlab:gitlab.test', 'group/demo', 'merge_request', 7, 'Add thing',
           'opened', 1, 1, 0, ?, ?)`
      )
      .run(ctx.hostId, ctx.now(), ctx.now())
  }

  function itemState(): string {
    const row = ctx.db
      .prepare("SELECT state FROM items WHERE kind = 'merge_request' AND iid = 7")
      .get()
    if (row === undefined) {
      throw new Error('expected the merge request item')
    }
    return rowText(row, 'state')
  }

  function record(action: ProjectEventDecisionAction, body: Buffer): number {
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: PROJECT_PATH,
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Merge Request Hook',
      dedupeKey: `delivery-${deliveries++}`,
      correlation: { eventUuid: null, configUuid: null },
      body
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }
    const decisionClaim = claimProjectEventDecision(ctx)
    if (!decisionClaim) {
      throw new Error('expected a project event decision claim')
    }
    if (!decideProjectEventDelivery(ctx, admitted.deliveryId, decision(action), decisionClaim).ok) {
      throw new Error('fixture could not record the decision')
    }
    return admitted.deliveryId
  }

  function deps(exec: Exec): ProjectEventActionDeps {
    return {
      // The open hook's own snapshot: the head before the merge, so the later merge hook
      // dedupes against it exactly the way the live host saw.
      observeContext: async () => ({
        ok: true,
        itemId: 1,
        revision: 2,
        versionToken: `sha256:${'9'.repeat(64)}`,
        complete: true,
        newRevision: true,
        kind: 'merge_request',
        iid: 7,
        sha: '1'.repeat(40),
        title: 'Add thing',
        state: 'opened'
      }),
      observeItemState: createForgeProjectEventItemStateObserver(ledger, exec),
      limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS
    }
  }

  it('records an authenticated state as the item head when a merge hid behind the dedupe', async () => {
    seedMergeRequestItem()
    const exec: Exec = async (args) => {
      expect(args[0]).toBe('api')
      return {
        stdout: glabResponse(mergeRequest),
        stderr: ''
      }
    }

    const state = await createForgeProjectEventItemStateObserver(ledger, exec)(claim(1), {
      kind: 'merge_request',
      iid: 7
    })

    expect(state).toBe('merged')
    expect(itemState()).toBe('merged')
    const revision = ctx.db
      .prepare(
        'SELECT version_token FROM item_revisions WHERE item_id = ? ORDER BY revision DESC LIMIT 1'
      )
      .get(1)
    if (revision === undefined) {
      throw new Error('expected the state revision')
    }
    expect(rowText(revision, 'version_token')).toBe('state:merge_request:7:merged')
  })

  it('returns null without a read when the claim has no linked item', async () => {
    let reads = 0
    const exec: Exec = async () => {
      reads += 1
      return { stdout: glabResponse(mergeRequest), stderr: '' }
    }

    expect(
      await createForgeProjectEventItemStateObserver(ledger, exec)(claim(null), {
        kind: 'merge_request',
        iid: 7
      })
    ).toBeNull()
    expect(reads).toBe(0)
  })

  it('verifies a reported merge through the action drain end to end', async () => {
    seedMergeRequestItem()
    const openSha = '1'.repeat(40)
    record('fetch_context', mergeRequestBody('opened', 'open', openSha))
    record('fetch_context', mergeRequestBody('merged', 'merge', openSha))
    const exec: Exec = async (args) => {
      const route = args[4]
      if (route === `projects/${GITLAB_PROJECT_ID}/merge_requests/7`) {
        return { stdout: glabResponse(mergeRequest), stderr: '' }
      }
      throw new Error(`unexpected glab route ${route}`)
    }

    expect(await drainProjectEventActions(ctx, deps(exec))).toEqual({
      executed: 2,
      failed: 0,
      capped: false
    })

    // Why: the merge hook repeats the open hook's head sha, so the context read dedupes — but the
    // request's own state moved, and only an authenticated re-read may record that.
    expect(itemState()).toBe('merged')
  })
})

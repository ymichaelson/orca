import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeItemTimelineEntry } from '../../shared/forge-inbox-item-timeline'
import { ingestForgeEventInTransaction } from './forge-inbox-ingest'
import { getForgeItemDetail, type ForgeItemDetail } from './forge-inbox-queries'
import {
  openProjectEventQuestionFixture,
  projectEventQuestionBody,
  projectEventQuestionDecision,
  type ProjectEventQuestionFixture
} from './forge-inbox-project-event-question-test-kit'
import { projectForgeItemDetail } from './forge-inbox-read-projection'
import {
  claimProjectEventAction,
  linkProjectEventDecisionItem
} from './forge-inbox-project-event-action'
import { settleProjectEventAction } from './forge-inbox-project-event-action-settle'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'
import { randomUUID } from 'node:crypto'
import { upsertProjectBinding } from './forge-inbox-project-binding'

describe('read projection of the item timeline', () => {
  let fixture: ProjectEventQuestionFixture
  let detail: ForgeItemDetail

  beforeEach(() => {
    fixture = openProjectEventQuestionFixture('forge-read-projection-')
    const ingested = ingestForgeEventInTransaction(fixture.ctx, {
      hostId: fixture.ctx.hostId,
      instanceId: 'inst-1',
      projectId: 'project-1',
      kind: 'issue',
      iid: 9,
      dedupeKey: 'dedupe-9',
      eventKind: 'Issue Hook',
      versionToken: 'sha-9',
      sourceOrder: 1,
      payload: {}
    })
    if (ingested.duplicate) {
      throw new Error('fixture expected a first delivery')
    }
    const read = getForgeItemDetail(
      fixture.ctx,
      { instanceId: 'inst-1' },
      ingested.itemId,
      'client-1'
    )
    if (!read) {
      throw new Error('expected item detail')
    }
    detail = read
  })

  afterEach(() => {
    fixture.close()
  })

  function project(timeline: ForgeItemTimelineEntry[]): ForgeItemTimelineEntry[] {
    return projectForgeItemDetail({ ...detail, timeline }).timeline ?? []
  }

  function decision(id: string, errorCode: string | null): ForgeItemTimelineEntry {
    return { kind: 'decision', id, at: 1, action: 'notify', state: 'blocked', errorCode }
  }

  it('replaces an unlisted decision error code and keeps a producer code', () => {
    const projected = project([
      decision('decision:1', 'secret/path /tmp/x'),
      decision('decision:2', 'dispatch-failed'),
      decision('decision:3', 'queue-full'),
      decision('decision:4', null),
      decision('decision:5', 'event-subject-unsupported'),
      decision('decision:6', 'event-project-mismatch')
    ])

    expect(projected.map((entry) => (entry.kind === 'decision' ? entry.errorCode : 'x'))).toEqual([
      'unknown',
      'dispatch-failed',
      'queue-full',
      null,
      'event-subject-unsupported',
      'event-project-mismatch'
    ])
  })

  it.each([
    'already-dispatched',
    'provisional-head',
    'dispatch-needs-observation',
    'notification-unsupported',
    'action-unsupported',
    'action-failed',
    'invalid-action',
    'awaiting-user',
    'crash-loop',
    'body-too-large',
    'binding-missing',
    'binding-mismatch',
    'dirty-observation',
    'stale-config',
    'aborted',
    'forbidden',
    'not-found',
    'rate-limited',
    'too-large',
    'request-too-large',
    'bad-response',
    'missing-checkout',
    'no-credential',
    'invalid-config',
    'response-too-large',
    'overloaded',
    'timeout'
  ])('keeps the project event pipeline code %s instead of reporting it as unknown', (code) => {
    const projected = project([decision('decision:1', code)])

    expect(projected.map((entry) => (entry.kind === 'decision' ? entry.errorCode : 'x'))).toEqual([
      code
    ])
  })

  it.each(['secret/path /tmp/x', 'dispatch-unconfigured'])(
    'projects current failed delivery and decision code %s through the same allowlist',
    (code) => {
      const { ctx } = fixture
      const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
        bindingId: fixture.bindingId,
        projectPath: 'group/demo',
        policyGeneration: 1,
        policyEnabled: true,
        eventKind: 'Merge Request Hook',
        dedupeKey: 'projection-current-failure',
        correlation: { eventUuid: null, configUuid: null },
        body: projectEventQuestionBody()
      })
      const decisionClaim = claimProjectEventDecision(ctx)
      if (!admitted.ok || decisionClaim === null) {
        throw new Error('expected delivery claim')
      }
      const decided = decideProjectEventDelivery(
        ctx,
        admitted.deliveryId,
        projectEventQuestionDecision('wait'),
        decisionClaim
      )
      const claim = claimProjectEventAction(ctx)
      if (!decided.ok || claim === null) {
        throw new Error('expected action claim')
      }
      const linked = linkProjectEventDecisionItem(ctx, claim)
      if (!linked.ok) {
        throw new Error('expected linked item')
      }
      expect(
        settleProjectEventAction(ctx, claim, { kind: 'blocked', code: 'dispatch-unconfigured' }).ok
      ).toBe(true)
      ctx.db
        .prepare('UPDATE project_event_decisions SET last_error_code = ? WHERE delivery_id = ?')
        .run(code, admitted.deliveryId)
      ctx.db
        .prepare('UPDATE webhook_deliveries SET last_error_code = ? WHERE id = ?')
        .run(code, admitted.deliveryId)
      const read = getForgeItemDetail(ctx, {}, linked.itemId, 'client-1')
      if (read === null) {
        throw new Error('expected item detail')
      }

      const view = projectForgeItemDetail(read)
      const expected = code === 'dispatch-unconfigured' ? code : 'unknown'
      expect(view.handling).toEqual({ state: 'failed', errorCode: expected })
      expect(view.timeline?.filter((entry) => entry.kind === 'decision')).toEqual([
        expect.objectContaining({ state: 'blocked', errorCode: expected })
      ])
      if (code !== expected) {
        expect(JSON.stringify(view)).not.toContain(code)
      }
    }
  )

  it('nulls an unlisted run reason on timeline entries and keeps a known one', () => {
    const projected = project([
      { kind: 'run', id: 'run:1', at: 1, state: 'failed', reason: 'free text /tmp/x' },
      { kind: 'run', id: 'run:2', at: 2, state: 'failed', reason: 'project-event-dispatch' }
    ])

    expect(projected.map((entry) => (entry.kind === 'run' ? entry.reason : 'x'))).toEqual([
      null,
      'project-event-dispatch'
    ])
  })

  it.each(['unique', 'ambiguous', 'other-owner', 'unlinked'])(
    'projects an Orca repo identity only from a unique owner-scoped binding: %s',
    (bindingCase) => {
      const { ctx } = fixture
      const ingested = ingestForgeEventInTransaction(ctx, {
        hostId: ctx.hostId,
        instanceId: 'gitlab:gitlab.test',
        projectId: 'group/demo',
        kind: 'issue',
        iid: 8,
        dedupeKey: 'bound-issue',
        eventKind: 'Issue Hook',
        versionToken: 'sha-8',
        sourceOrder: 1,
        payload: {}
      })
      if (ingested.duplicate) {
        throw new Error('expected first delivery')
      }
      if (bindingCase === 'ambiguous') {
        upsertProjectBinding(ctx, {
          bindingId: randomUUID(),
          projectPath: '/other-folder',
          gitlabHost: 'gitlab.test',
          gitlabPath: 'group/demo',
          gitlabProjectId: 4,
          callbackUrl: 'https://orca.example.com/another-binding'
        })
      } else if (bindingCase === 'other-owner') {
        ctx.db.prepare('UPDATE project_event_repo_links SET host_id = ?').run('another-owner')
      } else if (bindingCase === 'unlinked') {
        ctx.db.prepare('DELETE FROM project_event_repo_links').run()
      }
      const read = getForgeItemDetail(ctx, {}, ingested.itemId, 'client-1')
      if (read === null) {
        throw new Error('expected item detail')
      }

      expect(projectForgeItemDetail(read).repoId).toBe(bindingCase === 'unique' ? 'repo-1' : null)
      expect(projectForgeItemDetail(detail).repoId).toBeNull()
    }
  )

  it('projects run error codes and reasons through their allowlists', () => {
    const insert = fixture.ctx.db.prepare(`INSERT INTO runs (item_id, revision, state,
      policy_generation, context_digest, analysis_kind, reason, error, created_at, updated_at)
      VALUES (?, ?, 'failed', 1, 'digest', 'issue', ?, ?, 1, ?)`)
    insert.run(detail.item.id, 1, 'free text', 'secret/path /tmp/x', 2)
    insert.run(detail.item.id, 2, 'project-event-dispatch', 'workspace-ambiguous', 3)
    const read = getForgeItemDetail(
      fixture.ctx,
      { instanceId: 'inst-1' },
      detail.item.id,
      'client-1'
    )
    if (!read) {
      throw new Error('expected item detail')
    }

    const runs = projectForgeItemDetail(read).runs

    expect(runs.map((run) => [run.reason, run.errorCode]).sort()).toEqual([
      [null, 'unknown'],
      ['project-event-dispatch', 'workspace-ambiguous']
    ])
  })
})

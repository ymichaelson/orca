import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import {
  openQuestionPreparationHarness,
  PREPARED_QUESTION,
  type HarnessOptions,
  type QuestionPreparationHarness
} from './forge-inbox-project-event-question-preparation-test-kit'
import {
  openProjectEventQuestionFixture,
  projectEventQuestionDecision,
  type ProjectEventQuestionFixture
} from './forge-inbox-project-event-question-test-kit'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

const BOUND_PROJECT = { id: 3, path_with_namespace: 'group/demo', name: 'demo' }
const MERGE_REQUEST = {
  id: 99,
  iid: 7,
  title: 'Review this change',
  state: 'opened',
  source_branch: 'feature',
  target_branch: 'main',
  target_project_id: 3
}
const ISSUE = { id: 199, iid: 11, title: 'Question about change', state: 'opened' }

const noteHook = (attributes: Record<string, unknown>, subject: Record<string, unknown>) => ({
  object_kind: 'note',
  project: BOUND_PROJECT,
  object_attributes: { note: 'Please clarify', action: 'create', ...attributes },
  ...subject
})
const pipelineHook = (extra: Record<string, unknown> = {}) => ({
  object_kind: 'pipeline',
  project: BOUND_PROJECT,
  object_attributes: { id: 1001, status: 'failed', sha: 'a'.repeat(40), ref: 'feature' },
  commit: { id: 'a'.repeat(40), message: 'A change' },
  ...extra
})

type Case = {
  name: string
  eventKind: string
  payload: Record<string, unknown>
  subject: { kind: string; iid: number; title?: string } | null
  refusal?: string
}

const CASES: Case[] = [
  {
    name: 'a merge request note',
    eventKind: 'Note Hook',
    payload: noteHook(
      { id: 301, noteable_type: 'MergeRequest', noteable_id: 99 },
      { merge_request: MERGE_REQUEST }
    ),
    subject: { kind: 'merge_request', iid: 7, title: 'Review this change' }
  },
  {
    name: 'an issue note',
    eventKind: 'Note Hook',
    payload: noteHook({ id: 302, noteable_type: 'Issue', noteable_id: 199 }, { issue: ISSUE }),
    subject: { kind: 'issue', iid: 11, title: 'Question about change' }
  },
  {
    name: 'a commit note',
    eventKind: 'Note Hook',
    payload: noteHook(
      { id: 303, noteable_type: 'Commit' },
      { commit: { id: 'c'.repeat(40), message: 'A change' } }
    ),
    subject: null,
    refusal: 'event-subject-unsupported'
  },
  {
    name: 'a snippet note',
    eventKind: 'Note Hook',
    payload: noteHook(
      { id: 304, noteable_type: 'Snippet' },
      { snippet: { id: 5, title: 'A snippet' } }
    ),
    subject: null,
    refusal: 'event-subject-unsupported'
  },
  {
    name: 'a merge request note that carries no merge request',
    eventKind: 'Note Hook',
    payload: noteHook({ id: 305, noteable_type: 'MergeRequest', noteable_id: 99 }, {}),
    subject: null,
    refusal: 'invalid-input'
  },
  {
    name: 'a note from another project',
    eventKind: 'Note Hook',
    payload: {
      ...noteHook(
        { id: 306, noteable_type: 'MergeRequest', noteable_id: 99 },
        { merge_request: MERGE_REQUEST }
      ),
      project: { ...BOUND_PROJECT, id: 4 }
    },
    subject: null,
    refusal: 'event-project-mismatch'
  },
  {
    name: 'a pipeline from another project',
    eventKind: 'Pipeline Hook',
    payload: { ...pipelineHook(), project: { ...BOUND_PROJECT, id: 4 } },
    subject: null,
    refusal: 'event-project-mismatch'
  },
  {
    name: 'a standalone pipeline',
    eventKind: 'Pipeline Hook',
    payload: pipelineHook(),
    subject: { kind: 'pipeline', iid: 1001 }
  },
  {
    name: 'a pipeline on a merge request of the bound project',
    eventKind: 'Pipeline Hook',
    payload: pipelineHook({ merge_request: MERGE_REQUEST }),
    subject: { kind: 'merge_request', iid: 7 }
  },
  {
    name: 'a pipeline whose merge request lives in another project',
    eventKind: 'Pipeline Hook',
    payload: pipelineHook({ merge_request: { ...MERGE_REQUEST, target_project_id: 4 } }),
    subject: { kind: 'pipeline', iid: 1001 }
  },
  {
    name: 'a pipeline whose merge request does not say which project it targets',
    eventKind: 'Pipeline Hook',
    payload: pipelineHook({ merge_request: { id: 99, iid: 7, title: 'Review this change' } }),
    subject: { kind: 'pipeline', iid: 1001 }
  },
  {
    name: 'a merge request targeting another project',
    eventKind: 'Merge Request Hook',
    payload: {
      object_kind: 'merge_request',
      project: BOUND_PROJECT,
      object_attributes: { iid: 7, target_project_id: 4 },
      merge_request: { iid: 7, target_project_id: 4 }
    },
    subject: null,
    refusal: 'event-project-mismatch'
  },
  {
    name: 'a project push',
    eventKind: 'Push Hook',
    payload: {
      object_kind: 'push',
      project: BOUND_PROJECT,
      project_id: 3,
      ref: 'refs/heads/feature',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      checkout_sha: 'b'.repeat(40),
      commits: [{ id: 'b'.repeat(40), message: 'A change' }],
      total_commits_count: 1
    },
    subject: { kind: 'project', iid: 0 }
  },
  {
    name: 'a push from another project',
    eventKind: 'Push Hook',
    payload: {
      object_kind: 'push',
      project: { ...BOUND_PROJECT, id: 4 },
      project_id: 4,
      ref: 'refs/heads/feature',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40)
    },
    subject: null,
    refusal: 'event-project-mismatch'
  },
  {
    name: 'an event kind with no item to attach to',
    eventKind: 'Deployment Hook',
    payload: { object_kind: 'deployment', project: BOUND_PROJECT },
    subject: null,
    refusal: 'item-identity-missing'
  }
]

describe('project event subject of real GitLab payloads', () => {
  let fixture: ProjectEventQuestionFixture
  let ctx: ForgeLedgerContext
  let harness: QuestionPreparationHarness | null

  beforeEach(() => {
    fixture = openProjectEventQuestionFixture('orca-event-subject-')
    ctx = fixture.ctx
    harness = null
  })

  afterEach(() => {
    harness?.dispose()
    fixture.close()
  })

  async function askUser(testCase: Case, options: HarnessOptions = {}) {
    harness?.dispose()
    harness = openQuestionPreparationHarness(fixture.ledger, options)
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId: fixture.bindingId,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: testCase.eventKind,
      dedupeKey: testCase.name,
      correlation: { eventUuid: null, configUuid: null },
      body: Buffer.from(JSON.stringify(testCase.payload))
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }
    const claim = claimProjectEventDecision(ctx)
    if (!claim) {
      throw new Error('expected a project event decision claim')
    }
    const decided = decideProjectEventDelivery(
      ctx,
      admitted.deliveryId,
      projectEventQuestionDecision('ask_user'),
      claim
    )
    if (!decided.ok) {
      throw new Error('fixture could not record the decision')
    }
    const drained = await harness.drain()
    if (drained.executed === 1) {
      await harness.complete()
    }
    return drained
  }

  it.each(CASES.filter((testCase) => testCase.subject !== null))(
    'asks about the item behind $name',
    async (testCase) => {
      const subject = testCase.subject
      if (subject === null) {
        throw new Error('expected a subject')
      }
      expect(await askUser(testCase)).toMatchObject({ executed: 1, failed: 0 })

      expect(
        ctx.db
          .prepare(
            `SELECT i.kind, i.iid, q.question, q.subject_kind, q.subject_iid, q.subject_title
             FROM project_event_questions q JOIN items i ON i.id = q.item_id`
          )
          .all()
      ).toEqual([
        {
          kind: subject.kind,
          iid: subject.iid,
          question: PREPARED_QUESTION,
          subject_kind: subject.kind,
          subject_iid: subject.iid,
          subject_title: subject.title ?? (subject.kind === 'project' ? 'group/demo' : '')
        }
      ])
    }
  )

  it.each(CASES.filter((testCase) => testCase.subject === null))(
    'refuses $name with its own typed code and creates no item',
    async (testCase) => {
      expect(await askUser(testCase)).toMatchObject({ executed: 0, failed: 1 })

      expect(
        ctx.db.prepare('SELECT action_state, last_error_code FROM project_event_decisions').all()
      ).toEqual([{ action_state: 'blocked', last_error_code: testCase.refusal }])
      expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM items').get()).toEqual({ count: 0 })
    }
  )

  it('keeps a pipeline and a merge request that share a number as two items', async () => {
    const sharedNumber = 1001
    const mergeRequestNote: Case = {
      name: 'a note on merge request 1001',
      eventKind: 'Note Hook',
      payload: noteHook(
        { id: 401, noteable_type: 'MergeRequest', noteable_id: 99 },
        { merge_request: { ...MERGE_REQUEST, iid: sharedNumber } }
      ),
      subject: null
    }
    const pipeline: Case = {
      name: 'pipeline 1001',
      eventKind: 'Pipeline Hook',
      payload: pipelineHook({ object_attributes: { id: sharedNumber, status: 'failed' } }),
      subject: null
    }

    expect(await askUser(mergeRequestNote)).toMatchObject({ executed: 1, failed: 0 })
    expect(await askUser(pipeline)).toMatchObject({ executed: 1, failed: 0 })

    expect(ctx.db.prepare('SELECT kind, iid FROM items ORDER BY id').all()).toEqual([
      { kind: 'merge_request', iid: sharedNumber },
      { kind: 'pipeline', iid: sharedNumber }
    ])
  })

  it.each([
    ['a merge request note', 'Should merge request !7 be released now?'],
    ['an issue note', 'Should issue #11 wait for review?'],
    ['a standalone pipeline', 'Retry pipeline #1001?'],
    ['a project push', 'Should the latest project change be released?']
  ])('stores the prepared question verbatim for %s', async (name, question) => {
    const testCase = CASES.find((candidate) => candidate.name === name)
    if (!testCase) {
      throw new Error(`missing case ${name}`)
    }

    await askUser(testCase, { question })

    expect(ctx.db.prepare('SELECT question FROM project_event_questions').all()).toEqual([
      { question }
    ])
    expect(ctx.db.prepare('SELECT COUNT(*) AS runs FROM runs').get()).toEqual({ runs: 1 })
  })
})

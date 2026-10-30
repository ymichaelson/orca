import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { seedDispatchRun } from './forge-inbox-dispatch-confirmation-test-kit'
import {
  getDispatchConfirmationSchedule,
  reconcileDispatchConfirmations
} from './forge-inbox-dispatch-confirmation-reconcile'
import type {
  ConfirmationApprovals,
  ConfirmationMergeRequest,
  DispatchConfirmationReader
} from './forge-inbox-dispatch-confirmation-reader'
import type { DispatchClaim, DispatchReportCapture } from './forge-inbox-dispatch-report'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import type { GitlabApiResult } from './forge-inbox-gitlab-api-request'
import type { GitlabCurrentUser, GitlabNote } from './forge-inbox-gitlab-api-schemas'

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const HOST = 'gitlab.test'
const PROJECT_ID = 3
const MR = { kind: 'merge_request', iid: 7 } as const
const ok = <T>(data: T, complete = true): GitlabApiResult<T> => ({ ok: true, data, complete })
const failed = <T>(): GitlabApiResult<T> => ({ ok: false, code: 'network' })

type Script = {
  user?: GitlabApiResult<GitlabCurrentUser>
  mrNotes?: Record<number, GitlabApiResult<GitlabNote[]>>
  issueNotes?: Record<number, GitlabApiResult<GitlabNote[]>>
  mr?: Record<number, GitlabApiResult<ConfirmationMergeRequest>>
  approvals?: Record<number, GitlabApiResult<ConfirmationApprovals>>
  onCall?: (name: string) => void
}

function note(id: number, body: string, author = 'ada', system = false): GitlabNote {
  return { id, system, author, body, updated_at: '2026-01-01T00:00:00Z' }
}

function mergeRequest(overrides: Partial<ConfirmationMergeRequest> = {}): ConfirmationMergeRequest {
  return {
    iid: 7,
    state: 'opened',
    sha: SHA,
    targetProjectId: PROJECT_ID,
    mergedBy: null,
    ...overrides
  }
}

function approvals(overrides: Partial<ConfirmationApprovals> = {}): ConfirmationApprovals {
  return { approved: true, approvedBy: ['ada'], userHasApproved: true, ...overrides }
}

describe('dispatch confirmation reconciler', () => {
  let root: string
  let dbPath: string
  let ctx: ForgeLedgerContext
  let bindingId: string
  let now: number
  let nextIid: number
  let calls: string[]
  let readersBuilt: number

  function open(): ForgeLedgerContext {
    const opened = openForgeInboxDatabase(dbPath, 'host-1')
    return { db: opened.db, hostId: opened.hostId, now: () => now, secretStore: () => fakeStore() }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-reconcile-'))
    dbPath = join(root, 'forge-inbox.sqlite')
    now = 1_000_000
    nextIid = 100
    calls = []
    readersBuilt = 0
    ctx = open()
    bindingId = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: '/repo',
      gitlabHost: HOST,
      gitlabPath: 'group/demo',
      gitlabProjectId: PROJECT_ID,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
    })
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  function claims(
    items: DispatchClaim[],
    mode: 'remote-actions' | 'read-only' | 'unknown' = 'remote-actions'
  ) {
    return { status: 'claims', mode, claims: items } satisfies DispatchReportCapture
  }

  function seed(
    options: {
      report?: DispatchReportCapture | null
      itemKind?: 'merge_request' | 'issue' | 'project' | 'pipeline'
      itemIid?: number
      expectedSha?: string | null
      runState?: 'succeeded' | 'failed' | 'cancelled' | 'running'
    } = {}
  ): { runId: number; itemId: number; marker: string } {
    return seedDispatchRun(ctx, {
      binding: { bindingId, gitlabHost: HOST, gitlabProjectId: PROJECT_ID },
      storedIid: nextIid++,
      ...options,
      report:
        options.report === undefined ? claims([{ kind: 'comment', target: MR }]) : options.report
    })
  }

  function reader(script: Script = {}): DispatchConfirmationReader {
    const track = <T>(name: string, value: T): T => {
      calls.push(name)
      script.onCall?.(name)
      return value
    }
    return {
      getCurrentUser: async () =>
        track(
          'getCurrentUser',
          script.user ?? ok({ name: 'Ada', username: 'ada', email: null, commit_email: null })
        ),
      listMergeRequestNotes: async (iid) =>
        track(`listMergeRequestNotes:${iid}`, script.mrNotes?.[iid] ?? ok([])),
      listIssueNotes: async (iid) =>
        track(`listIssueNotes:${iid}`, script.issueNotes?.[iid] ?? ok([])),
      getMergeRequestState: async (iid) =>
        track(`getMergeRequestState:${iid}`, script.mr?.[iid] ?? ok(mergeRequest({ iid }))),
      getMergeRequestApprovals: async (iid) =>
        track(`getMergeRequestApprovals:${iid}`, script.approvals?.[iid] ?? ok(approvals()))
    }
  }

  async function reconcile(script: Script = {}, signal?: AbortSignal) {
    return reconcileDispatchConfirmations(
      ctx,
      {
        createReader: () => {
          readersBuilt += 1
          return reader(script)
        }
      },
      signal
    )
  }

  function row(runId: number) {
    const found = ctx.db
      .prepare(
        `SELECT state, attempts, next_attempt_at, deadline_at, evidence_json
         FROM run_dispatch_confirmations WHERE run_id = ?`
      )
      .get(runId)
    if (!found) {
      throw new Error('expected the confirmation row')
    }
    return {
      state: String(found.state),
      attempts: Number(found.attempts),
      nextAttemptAt: found.next_attempt_at === null ? null : Number(found.next_attempt_at),
      deadlineAt: found.deadline_at === null ? null : Number(found.deadline_at),
      evidence: found.evidence_json === null ? null : JSON.parse(String(found.evidence_json))
    }
  }

  function outcomes(runId: number) {
    return (row(runId).evidence?.claims ?? []).map(
      (claim: { kind: string; outcome: string; code: string; attribution: string | null }) => ({
        kind: claim.kind,
        outcome: claim.outcome,
        code: claim.code,
        attribution: claim.attribution
      })
    )
  }

  describe('comments', () => {
    it('confirms a comment only by a note carrying the run marker from the current user', async () => {
      const { runId, itemId, marker } = seed()

      await reconcile({
        mrNotes: { 7: ok([note(1, 'unrelated'), note(2, `Looks good\n${marker}`)]) }
      })

      expect(row(runId).state).toBe('confirmed')
      expect(outcomes(runId)).toEqual([
        { kind: 'comment', outcome: 'confirmed', code: 'marker-note', attribution: 'marker-author' }
      ])
      expect(calls).toEqual(['getCurrentUser', 'listMergeRequestNotes:7'])
      expect(
        ctx.db
          .prepare(
            "SELECT change FROM changes WHERE item_id = ? AND entity = 'run' ORDER BY seq DESC"
          )
          .get(itemId)
      ).toEqual({ change: 'dispatch-confirmed' })
    })

    it.each([
      ['another author', (marker: string) => note(2, marker, 'mallory')],
      ['a system note', (marker: string) => note(2, marker, 'ada', true)],
      ['a note without the marker', () => note(2, 'looks good')],
      ['a different run marker', () => note(2, '<!-- orca-run:1:other -->')]
    ])('does not count %s as proof', async (_name, make) => {
      const { runId, marker } = seed()

      await reconcile({ mrNotes: { 7: ok([make(marker)]) } })

      expect(row(runId).state).toBe('unconfirmed')
      expect(outcomes(runId)).toEqual([
        { kind: 'comment', outcome: 'unproven', code: 'marker-not-found', attribution: null }
      ])
    })

    it('proves presence from a truncated list but never absence', async () => {
      const found = seed()
      const missing = seed()

      await reconcile({
        mrNotes: {
          7: ok([note(2, found.marker)], false)
        }
      })

      expect(row(found.runId).state).toBe('confirmed')
      expect(row(missing.runId).state).toBe('unconfirmed')
      expect(outcomes(missing.runId)[0]).toMatchObject({ outcome: 'unproven' })

      const lone = seed()
      await reconcile({ mrNotes: { 7: ok([note(3, 'other')], false) } })
      expect(outcomes(lone.runId)).toEqual([
        {
          kind: 'comment',
          outcome: 'unproven',
          code: 'marker-not-found-truncated',
          attribution: null
        }
      ])
    })

    it('requires the reported note id to be one of the marker notes', async () => {
      const wrong = seed({ report: claims([{ kind: 'comment', target: MR, noteId: 99 }]) })
      const right = seed({ report: claims([{ kind: 'comment', target: MR, noteId: 3 }]) })

      await reconcile({ mrNotes: { 7: ok([note(2, wrong.marker), note(3, right.marker)]) } })

      expect(outcomes(wrong.runId)).toEqual([
        { kind: 'comment', outcome: 'unproven', code: 'note-id-mismatch', attribution: null }
      ])
      expect(row(wrong.runId).state).toBe('unconfirmed')
      expect(row(right.runId).state).toBe('confirmed')
    })

    it('needs one marker note for every reported comment on the same target', async () => {
      const two = seed({
        report: claims([
          { kind: 'comment', target: MR },
          { kind: 'comment', target: MR }
        ])
      })

      await reconcile({ mrNotes: { 7: ok([note(2, two.marker)]) } })
      expect(row(two.runId).state).toBe('unconfirmed')

      now += 60_000
      await reconcile({ mrNotes: { 7: ok([note(2, two.marker), note(3, two.marker)]) } })
      expect(row(two.runId).state).toBe('confirmed')
    })

    it('reads issue notes for an issue target', async () => {
      const { runId, marker } = seed({
        itemKind: 'issue',
        itemIid: 9,
        report: claims([{ kind: 'comment', target: { kind: 'issue', iid: 9 } }])
      })

      await reconcile({ issueNotes: { 9: ok([note(5, marker)]) } })

      expect(row(runId).state).toBe('confirmed')
      expect(calls).toEqual(['getCurrentUser', 'listIssueNotes:9'])
    })
  })

  describe('approvals and merges', () => {
    const approve = (sha?: string): DispatchClaim => ({
      kind: 'approve',
      target: MR,
      ...(sha ? { expectedHeadSha: sha } : {})
    })
    const merge = (sha?: string): DispatchClaim => ({
      kind: 'merge',
      target: MR,
      ...(sha ? { expectedHeadSha: sha } : {})
    })

    it('confirms an approval observed at the prompted sha as state-only', async () => {
      const { runId } = seed({ report: claims([approve(SHA)]) })

      await reconcile()

      expect(row(runId).state).toBe('confirmed')
      expect(outcomes(runId)).toEqual([
        {
          kind: 'approve',
          outcome: 'confirmed',
          code: 'approved-at-sha',
          attribution: 'state-only'
        }
      ])
      expect(calls).toEqual([
        'getCurrentUser',
        'getMergeRequestState:7',
        'getMergeRequestApprovals:7'
      ])
    })

    it('uses the prompted sha when the report names none', async () => {
      const { runId } = seed({ report: claims([approve()]) })

      await reconcile()

      expect(row(runId).state).toBe('confirmed')
    })

    it('contradicts an approval that GitLab does not show', async () => {
      const { runId } = seed({ report: claims([approve(SHA)]) })

      await reconcile({
        approvals: { 7: ok(approvals({ approved: false, approvedBy: [], userHasApproved: false })) }
      })

      expect(row(runId).state).toBe('contradicted')
      expect(outcomes(runId)).toEqual([
        { kind: 'approve', outcome: 'contradicted', code: 'not-approved', attribution: null }
      ])
    })

    it('cannot confirm an approval once the head moved, but does not call it false', async () => {
      const { runId } = seed({ report: claims([approve(SHA)]) })

      await reconcile({ mr: { 7: ok(mergeRequest({ sha: OTHER_SHA })) } })

      expect(row(runId).state).toBe('unconfirmable')
      expect(outcomes(runId)[0]).toMatchObject({ outcome: 'unconfirmable', code: 'head-moved' })
    })

    it('contradicts a report whose sha differs from the one the host prompted', async () => {
      const { runId } = seed({ report: claims([approve(OTHER_SHA)]) })

      await reconcile()

      expect(row(runId).state).toBe('contradicted')
      expect(outcomes(runId)[0]).toMatchObject({ code: 'sha-mismatch' })
    })

    it('cannot confirm an approval or merge when no sha was ever prompted', async () => {
      const { runId } = seed({ expectedSha: null, report: claims([merge()]) })

      await reconcile()

      expect(row(runId).state).toBe('unconfirmable')
      expect(outcomes(runId)).toEqual([
        { kind: 'merge', outcome: 'unconfirmable', code: 'no-expected-sha', attribution: null }
      ])
      expect(calls).toEqual([])
    })

    it('confirms a merge at the prompted sha as state-only, even when the current user merged it', async () => {
      const byUser = seed({ report: claims([merge(SHA)]) })
      await reconcile({ mr: { 7: ok(mergeRequest({ state: 'merged', mergedBy: 'ada' })) } })
      expect(outcomes(byUser.runId)).toEqual([
        { kind: 'merge', outcome: 'confirmed', code: 'merged-at-sha', attribution: 'state-only' }
      ])

      const stateOnly = seed({ report: claims([merge(SHA)]) })
      await reconcile({ mr: { 7: ok(mergeRequest({ state: 'merged', mergedBy: null })) } })
      expect(row(stateOnly.runId).state).toBe('confirmed')
      expect(outcomes(stateOnly.runId)[0]).toMatchObject({ attribution: 'state-only' })
    })

    it.each([
      [
        'merged by someone else',
        { state: 'merged', mergedBy: 'mallory' },
        'contradicted',
        'merged-by-other'
      ],
      [
        'merged at another sha',
        { state: 'merged', sha: OTHER_SHA, mergedBy: 'ada' },
        'unconfirmable',
        'head-moved'
      ],
      ['closed without a merge', { state: 'closed' }, 'contradicted', 'not-merged'],
      ['still open', { state: 'opened' }, 'unconfirmed', 'not-merged-yet']
    ])('reads a merge claim on a request %s', async (_name, overrides, state, code) => {
      const { runId } = seed({ report: claims([merge(SHA)]) })

      await reconcile({ mr: { 7: ok(mergeRequest(overrides)) } })

      expect(row(runId).state).toBe(state)
      expect(outcomes(runId)[0]).toMatchObject({ code })
    })
  })

  describe('project items', () => {
    const pushSha = OTHER_SHA
    const approveProject = (sha?: string): DispatchClaim => ({
      kind: 'approve',
      target: { kind: 'merge_request', iid: 12 },
      ...(sha ? { expectedHeadSha: sha } : {})
    })

    it('checks a merge request approval against the revision the agent reports, not the push', async () => {
      const { runId } = seed({
        itemKind: 'project',
        itemIid: 0,
        expectedSha: pushSha,
        report: claims([approveProject(SHA)])
      })

      await reconcile({ mr: { 12: ok(mergeRequest({ iid: 12, sha: SHA })) } })

      expect(row(runId).state).toBe('confirmed')
      expect(outcomes(runId)[0]).toMatchObject({ attribution: 'state-only' })
    })

    it('cannot tie an approval to any host-prompted revision when the report names none', async () => {
      const { runId } = seed({
        itemKind: 'project',
        itemIid: 0,
        expectedSha: pushSha,
        report: claims([approveProject()])
      })

      await reconcile()

      expect(row(runId).state).toBe('unconfirmable')
      expect(outcomes(runId)[0]).toMatchObject({ code: 'no-expected-sha' })
      expect(calls).toEqual([])
    })

    it('does not call a head that differs from the reported one a contradiction', async () => {
      const { runId } = seed({
        itemKind: 'project',
        itemIid: 0,
        expectedSha: pushSha,
        report: claims([approveProject(SHA)])
      })

      await reconcile({ mr: { 12: ok(mergeRequest({ iid: 12, sha: 'c'.repeat(40) })) } })

      expect(row(runId).state).toBe('unconfirmable')
      expect(outcomes(runId)[0]).toMatchObject({ code: 'head-moved' })
    })
  })

  describe('targets and bindings', () => {
    it('does not read for a claim about anything but the item itself', async () => {
      const mr = seed({
        report: claims([{ kind: 'comment', target: { kind: 'merge_request', iid: 8 } }])
      })
      const kind = seed({
        report: claims([{ kind: 'comment', target: { kind: 'issue', iid: 7 } }])
      })
      const pipeline = seed({ itemKind: 'pipeline', itemIid: 7 })

      await reconcile()

      for (const run of [mr, kind, pipeline]) {
        expect(row(run.runId).state).toBe('unconfirmable')
        expect(outcomes(run.runId)).toEqual([
          { kind: 'comment', outcome: 'unconfirmable', code: 'off-target', attribution: null }
        ])
      }
      expect(calls).toEqual([])
    })

    it('lets a project item claim about a merge request in its bound project', async () => {
      const { runId, marker } = seed({
        itemKind: 'project',
        itemIid: 0,
        report: claims([{ kind: 'comment', target: { kind: 'merge_request', iid: 12 } }])
      })

      await reconcile({ mrNotes: { 12: ok([note(4, marker)]) } })

      expect(row(runId).state).toBe('confirmed')
    })

    it('refuses a merge request from another target project', async () => {
      const { runId } = seed({
        itemKind: 'project',
        itemIid: 0,
        expectedSha: SHA,
        report: claims([
          { kind: 'approve', target: { kind: 'merge_request', iid: 12 }, expectedHeadSha: SHA }
        ])
      })

      await reconcile({ mr: { 12: ok(mergeRequest({ iid: 12, targetProjectId: 99 })) } })

      expect(row(runId).state).toBe('unconfirmable')
      expect(outcomes(runId)[0]).toMatchObject({ code: 'off-target' })
    })

    it.each([
      ['relinked to another project', 'UPDATE project_bindings SET gitlab_project_id = 4'],
      ['moved to another host', "UPDATE project_bindings SET gitlab_host = 'other.test'"],
      ['removed', 'DELETE FROM project_bindings']
    ])('is unconfirmable without any read once the binding was %s', async (_name, sql) => {
      const { runId } = seed()
      ctx.db.pragma('foreign_keys = OFF')
      ctx.db.exec(sql)

      await reconcile()

      expect(row(runId).state).toBe('unconfirmable')
      expect(row(runId).evidence).toMatchObject({ code: 'binding-changed' })
      expect(readersBuilt).toBe(0)
      expect(calls).toEqual([])
    })
  })

  describe('reports', () => {
    const withoutReads: [string, DispatchReportCapture | null, string][] = [
      ['no captured report', null, 'report-missing'],
      ['a missing report', { status: 'report-missing' }, 'report-missing'],
      ['an ambiguous report', { status: 'ambiguous' }, 'report-ambiguous'],
      ['an unsure agent', claims([], 'unknown'), 'mode-unknown'],
      ['remote actions with no claims', claims([], 'remote-actions'), 'no-claims-reported']
    ]

    it.each(withoutReads)(
      'is unconfirmable for %s, without reading',
      async (_name, report, code) => {
        const { runId } = seed({ report })

        await reconcile()

        expect(row(runId).state).toBe('unconfirmable')
        expect(row(runId).evidence).toMatchObject({ code })
        expect(readersBuilt).toBe(0)
      }
    )

    describe('a read-only report', () => {
      const readOnly = () => claims([], 'read-only')

      it('is no claim only after the item own notes were listed completely without the marker', async () => {
        const { runId } = seed({ report: readOnly() })

        await reconcile({ mrNotes: { 7: ok([note(1, 'unrelated'), note(2, 'x', 'mallory')]) } })

        expect(row(runId).state).toBe('no-claim')
        expect(row(runId).evidence).toMatchObject({ code: 'read-only-report' })
        expect(calls).toEqual(['getCurrentUser', 'listMergeRequestNotes:7'])
      })

      it('reads an issue item own notes', async () => {
        const { runId } = seed({ itemKind: 'issue', itemIid: 9, report: readOnly() })

        await reconcile()

        expect(row(runId).state).toBe('no-claim')
        expect(calls).toEqual(['getCurrentUser', 'listIssueNotes:9'])
      })

      it('is contradicted by a stray marker comment the report left out', async () => {
        const { runId, marker } = seed({ report: readOnly() })

        await reconcile({ mrNotes: { 7: ok([note(3, `oops\n${marker}`)]) } })

        expect(row(runId).state).toBe('contradicted')
        expect(row(runId).evidence).toMatchObject({ code: 'unreported-comment' })
      })

      it('is contradicted by a stray marker even in a truncated list', async () => {
        const { runId, marker } = seed({ report: readOnly() })

        await reconcile({ mrNotes: { 7: ok([note(3, marker)], false) } })

        expect(row(runId).state).toBe('contradicted')
      })

      it('cannot prove absence from a truncated list', async () => {
        const { runId } = seed({ report: readOnly() })

        await reconcile({ mrNotes: { 7: ok([note(1, 'unrelated')], false) } })

        expect(row(runId).state).toBe('unconfirmable')
        expect(row(runId).evidence).toMatchObject({ code: 'read-only-unchecked' })
      })

      it('stays unconfirmed and retries when the notes cannot be read', async () => {
        const { runId } = seed({ report: readOnly() })

        await reconcile({ mrNotes: { 7: failed() } })
        expect(row(runId)).toMatchObject({ state: 'unconfirmed', attempts: 1 })

        now += 60_000
        await reconcile({ mrNotes: { 7: ok([]) } })
        expect(row(runId)).toMatchObject({ state: 'no-claim', attempts: 2 })
      })

      it('stays unconfirmed when the current user cannot be read to tell whose comments are whose', async () => {
        const { runId } = seed({ report: readOnly() })

        await reconcile({ user: failed() })

        expect(row(runId)).toMatchObject({ state: 'unconfirmed', attempts: 1 })
        expect(calls).toEqual(['getCurrentUser'])
      })

      it.each(['project', 'pipeline'] as const)(
        'is unconfirmable for a %s item, whose notes cannot be listed',
        async (itemKind) => {
          const { runId } = seed({
            itemKind,
            itemIid: itemKind === 'project' ? 0 : 7,
            report: readOnly()
          })

          await reconcile()

          expect(row(runId).state).toBe('unconfirmable')
          expect(row(runId).evidence).toMatchObject({ code: 'read-only-unchecked' })
          expect(calls).toEqual([])
        }
      )

      it('is unconfirmable once the binding changed, without a read', async () => {
        const { runId } = seed({ report: readOnly() })
        ctx.db.pragma('foreign_keys = OFF')
        ctx.db.exec('DELETE FROM project_bindings')

        await reconcile()

        expect(row(runId).state).toBe('unconfirmable')
        expect(row(runId).evidence).toMatchObject({ code: 'binding-changed' })
        expect(calls).toEqual([])
      })
    })

    it('caps an unsure agent at unconfirmable even when every claim verifies', async () => {
      const { runId, marker } = seed({
        report: claims([{ kind: 'comment', target: MR }], 'unknown')
      })

      await reconcile({ mrNotes: { 7: ok([note(2, marker)]) } })

      expect(row(runId).state).toBe('unconfirmable')
      expect(row(runId).evidence).toMatchObject({ code: 'mode-unknown' })
    })

    it('lets a contradiction win over an unsure agent', async () => {
      const { runId } = seed({ report: claims([{ kind: 'approve', target: MR }], 'unknown') })

      await reconcile({
        approvals: { 7: ok(approvals({ approved: false, approvedBy: [], userHasApproved: false })) }
      })

      expect(row(runId).state).toBe('contradicted')
    })

    it('keeps work the agent says it left unfinished unconfirmable, behind a contradiction', async () => {
      const open = seed({ report: claims([{ kind: 'unfinished', target: MR }], 'unknown') })
      const both = seed({
        report: claims([
          { kind: 'unfinished', target: MR },
          { kind: 'approve', target: MR }
        ])
      })

      await reconcile({
        approvals: { 7: ok(approvals({ approved: false, approvedBy: [], userHasApproved: false })) }
      })

      expect(row(open.runId).state).toBe('unconfirmable')
      expect(outcomes(open.runId)).toEqual([
        {
          kind: 'unfinished',
          outcome: 'unconfirmable',
          code: 'agent-unfinished',
          attribution: null
        }
      ])
      expect(row(both.runId).state).toBe('contradicted')
    })

    it('lets any contradiction win over a confirmed claim', async () => {
      const { runId, marker } = seed({
        report: claims([
          { kind: 'comment', target: MR },
          { kind: 'approve', target: MR }
        ])
      })

      await reconcile({
        mrNotes: { 7: ok([note(2, marker)]) },
        approvals: { 7: ok(approvals({ approved: false, approvedBy: [], userHasApproved: false })) }
      })

      expect(row(runId).state).toBe('contradicted')
      expect(outcomes(runId).map((claim: { outcome: string }) => claim.outcome)).toEqual([
        'confirmed',
        'contradicted'
      ])
    })

    it('leaves a run that has not settled alone, and checks failed and cancelled ones', async () => {
      const live = seed({ runState: 'running' })
      const failedRun = seed({ runState: 'failed', report: claims([], 'read-only') })
      const cancelled = seed({ runState: 'cancelled', report: claims([], 'read-only') })

      const result = await reconcile()

      expect(result.checked).toBe(2)
      expect(row(live.runId)).toMatchObject({ state: 'unconfirmed', attempts: 0 })
      expect(row(failedRun.runId).state).toBe('no-claim')
      expect(row(cancelled.runId).state).toBe('no-claim')
    })
  })

  describe('attempts, deadline and restart', () => {
    it('persists the attempt before the first read and schedules the next one', async () => {
      const { runId } = seed()
      let seen: { attempts: number; deadlineAt: number | null } | null = null

      await reconcile({
        user: failed(),
        onCall: () => {
          const current = row(runId)
          seen ??= { attempts: current.attempts, deadlineAt: current.deadlineAt }
        }
      })

      expect(seen).toEqual({ attempts: 1, deadlineAt: now + 10 * 60_000 })
      expect(row(runId)).toMatchObject({ state: 'unconfirmed', attempts: 1 })
      expect(row(runId).nextAttemptAt).toBeGreaterThan(now)
      expect(outcomes(runId)).toEqual([
        { kind: 'comment', outcome: 'unproven', code: 'read-failed', attribution: null }
      ])
    })

    it('does not read again before the next attempt is due', async () => {
      const { runId } = seed()
      await reconcile({ user: failed() })
      calls = []

      await reconcile({ user: failed() })

      expect(calls).toEqual([])
      expect(row(runId).attempts).toBe(1)
    })

    it('gives up as unconfirmable after four unproven attempts', async () => {
      const { runId } = seed()

      for (let attempt = 1; attempt <= 4; attempt++) {
        expect(row(runId).state).toBe('unconfirmed')
        await reconcile({ user: failed() })
        now += 130_000
      }

      expect(row(runId)).toMatchObject({ state: 'unconfirmable', attempts: 4 })
      expect(row(runId).evidence).toMatchObject({ code: 'unproven' })
    })

    it('gives up at the deadline after one last read that proves nothing', async () => {
      const { runId } = seed()
      await reconcile({ user: failed() })
      now += 11 * 60_000
      calls = []

      await reconcile({ user: failed() })

      expect(calls).toEqual(['getCurrentUser'])
      expect(row(runId).state).toBe('unconfirmable')
      expect(row(runId).evidence).toMatchObject({ code: 'deadline' })
    })

    it('still confirms past the deadline when the last read proves the claim', async () => {
      const { runId, marker } = seed()
      await reconcile({ user: failed() })
      now += 11 * 60_000

      await reconcile({ mrNotes: { 7: ok([note(2, marker)]) } })

      expect(row(runId).state).toBe('confirmed')
    })

    it('counts a read that never came back, and treats a thrown read as unproven', async () => {
      const { runId } = seed()
      const throwing = reader()
      throwing.getCurrentUser = async () => {
        throw new Error('glab vanished')
      }

      await reconcileDispatchConfirmations(ctx, { createReader: () => throwing })

      expect(row(runId)).toMatchObject({ state: 'unconfirmed', attempts: 1 })
      expect(outcomes(runId)[0]).toMatchObject({ outcome: 'unproven', code: 'read-failed' })
    })

    it('continues the persisted attempts and deadline after a restart, reading once before a deadline verdict', async () => {
      const { runId } = seed()
      await reconcile({ user: failed() })
      const before = row(runId)
      ctx.db.close()
      now += 200_000

      ctx = open()
      await reconcile({ user: failed() })

      expect(row(runId)).toMatchObject({ attempts: 2, deadlineAt: before.deadlineAt })

      ctx.db.close()
      now += 9 * 60_000
      ctx = open()
      calls = []
      await reconcile({ user: failed() })

      expect(calls).toEqual(['getCurrentUser'])
      expect(row(runId).state).toBe('unconfirmable')
      expect(row(runId).evidence).toMatchObject({ code: 'deadline' })
    })

    it('does not spend or finalize an attempt that shutdown interrupted mid-read', async () => {
      const { runId } = seed()
      await reconcile({ user: failed() })
      now += 130_000
      const before = row(runId)
      const controller = new AbortController()

      await reconcile({ user: failed(), onCall: () => controller.abort() }, controller.signal)

      expect(row(runId)).toEqual(before)
    })

    it('does not give up on the fourth attempt when shutdown cut the read short', async () => {
      const { runId } = seed()
      ctx.db
        .prepare('UPDATE run_dispatch_confirmations SET attempts = 3 WHERE run_id = ?')
        .run(runId)
      const controller = new AbortController()

      await reconcile({ user: failed(), onCall: () => controller.abort() }, controller.signal)

      expect(row(runId)).toMatchObject({ state: 'unconfirmed', attempts: 3 })
    })

    it('keeps draining past a row that fails and counts that failure against it', async () => {
      const bad = seed()
      const good = seed({ report: claims([], 'read-only') })
      ctx.db.exec(`CREATE TRIGGER fail_bad BEFORE UPDATE OF state ON run_dispatch_confirmations
        WHEN NEW.run_id = ${bad.runId} BEGIN SELECT RAISE(ABORT, 'disk trouble'); END`)

      await expect(reconcile({ mrNotes: { 7: ok([note(2, bad.marker)]) } })).resolves.toMatchObject(
        {
          checked: 2
        }
      )

      expect(row(good.runId).state).toBe('no-claim')
      expect(row(bad.runId)).toMatchObject({ state: 'unconfirmed', attempts: 1 })
      expect(row(bad.runId).nextAttemptAt).toBeGreaterThan(now)
    })

    it('pushes a row out of the due window even when finishing it keeps failing', async () => {
      const bad = seed({ report: { status: 'report-missing' } })
      ctx.db
        .prepare('UPDATE run_dispatch_confirmations SET attempts = 3 WHERE run_id = ?')
        .run(bad.runId)
      ctx.db.exec(`CREATE TRIGGER fail_any BEFORE UPDATE OF state ON run_dispatch_confirmations
        WHEN NEW.run_id = ${bad.runId} BEGIN SELECT RAISE(ABORT, 'disk trouble'); END`)

      await expect(reconcile()).resolves.toMatchObject({ checked: 1 })

      expect(row(bad.runId).state).toBe('unconfirmed')
      expect(row(bad.runId).nextAttemptAt).toBeGreaterThan(now)
      expect(getDispatchConfirmationSchedule(ctx).nextAttemptAtMs).toBeGreaterThan(now)
    })

    it('refreshes a retry after a slow fourth read and failed finalization so a later good row progresses', async () => {
      const bad = Array.from({ length: 20 }, () => seed())
      ctx.db.exec('UPDATE run_dispatch_confirmations SET attempts = 3')
      const good = seed({ report: { status: 'report-missing' } })
      ctx.db.exec(`CREATE TRIGGER fail_bad BEFORE UPDATE OF state ON run_dispatch_confirmations
        WHEN NEW.run_id < ${good.runId} BEGIN SELECT RAISE(ABORT, 'disk trouble'); END`)

      expect(
        await reconcile({
          user: failed(),
          onCall: () => {
            now = 1_130_000
          }
        })
      ).toEqual({ checked: 20, capped: true })
      expect(row(bad[0].runId)).toMatchObject({
        state: 'unconfirmed',
        attempts: 4,
        nextAttemptAt: now + 120_000
      })
      expect(row(good.runId).state).toBe('unconfirmed')

      expect(await reconcile()).toEqual({ checked: 1, capped: false })
      expect(row(good.runId).state).toBe('unconfirmable')
      expect(getDispatchConfirmationSchedule(ctx)).toEqual({
        pending: 20,
        nextAttemptAtMs: now + 120_000
      })
      expect(readersBuilt).toBe(20)
      expect(calls).toEqual(Array.from({ length: 20 }, () => 'getCurrentUser'))
    })

    it('gives a repeatedly failing row up instead of retrying forever', async () => {
      const bad = seed()
      ctx.db.exec(`CREATE TRIGGER fail_bad BEFORE UPDATE OF state ON run_dispatch_confirmations
        WHEN NEW.run_id = ${bad.runId} AND NEW.state = 'confirmed' BEGIN SELECT RAISE(ABORT, 'x'); END`)

      for (let attempt = 0; attempt < 4; attempt++) {
        await expect(
          reconcile({ mrNotes: { 7: ok([note(2, bad.marker)]) } })
        ).resolves.toBeDefined()
        now += 130_000
      }

      expect(row(bad.runId)).toMatchObject({ state: 'unconfirmable', attempts: 4 })
    })

    it('stops between rows once aborted', async () => {
      seed()
      seed()
      const controller = new AbortController()

      const result = await reconcile({ onCall: () => controller.abort() }, controller.signal)

      expect(result.checked).toBe(1)
    })
  })

  describe('schedule', () => {
    it('counts settled unconfirmed rows and reports the earliest due time', async () => {
      seed({ runState: 'running' })
      expect(getDispatchConfirmationSchedule(ctx)).toEqual({ pending: 0, nextAttemptAtMs: null })

      const first = seed()
      expect(getDispatchConfirmationSchedule(ctx)).toEqual({ pending: 1, nextAttemptAtMs: 0 })

      await reconcile({ user: failed() })
      const schedule = getDispatchConfirmationSchedule(ctx)
      expect(schedule.pending).toBe(1)
      expect(schedule.nextAttemptAtMs).toBe(row(first.runId).nextAttemptAt)

      now += 11 * 60_000
      await reconcile()
      expect(getDispatchConfirmationSchedule(ctx)).toEqual({ pending: 0, nextAttemptAtMs: null })
    })
  })
})

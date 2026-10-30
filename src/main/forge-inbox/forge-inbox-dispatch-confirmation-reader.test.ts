import { describe, expect, it } from 'vitest'
import {
  createDispatchConfirmationReader,
  createGlabDispatchConfirmationReaderFactory
} from './forge-inbox-dispatch-confirmation-reader'
import type { GitlabApiRequester } from './forge-inbox-gitlab-api-request'

const SCOPE = { baseUrl: 'https://gitlab.test', projectId: '3', expectedConfigRevision: 0 }

function readerFor(responses: Record<string, unknown>) {
  const paths: string[] = []
  const requester: GitlabApiRequester = {
    get: async (path) => {
      paths.push(path)
      if (!(path in responses)) {
        return { ok: false, code: 'not-found' }
      }
      return { ok: true, json: responses[path], headers: new Headers() }
    }
  }
  const reader = createDispatchConfirmationReader(
    {
      requester,
      textRequester: { getText: async () => ({ ok: false, code: 'bad-response' }) },
      instanceRequester: requester
    },
    SCOPE
  )
  return { reader, paths }
}

describe('dispatch confirmation reader', () => {
  it('reads the merge fields of a merge request and tolerates absent ones', async () => {
    const { reader, paths } = readerFor({
      '/merge_requests/7': {
        iid: 7,
        state: 'merged',
        sha: 'a'.repeat(40),
        target_project_id: 3,
        source_project_id: 3,
        merged_by: { id: 1, username: 'ada', name: 'Ada' },
        merge_user: { id: 1, username: 'ada' },
        merge_commit_sha: 'b'.repeat(40),
        title: 'ignored'
      },
      '/merge_requests/8': { iid: 8, state: 'opened', sha: null, merged_by: null }
    })

    expect(await reader.getMergeRequestState(7)).toEqual({
      ok: true,
      complete: true,
      data: { iid: 7, state: 'merged', sha: 'a'.repeat(40), targetProjectId: 3, mergedBy: 'ada' }
    })
    expect(await reader.getMergeRequestState(8)).toEqual({
      ok: true,
      complete: true,
      data: { iid: 8, state: 'opened', sha: null, targetProjectId: null, mergedBy: null }
    })
    expect(paths).toEqual(['/merge_requests/7', '/merge_requests/8'])
  })

  it('prefers merged_by and falls back to merge_user', async () => {
    const { reader } = readerFor({
      '/merge_requests/9': { iid: 9, state: 'merged', sha: null, merge_user: { username: 'bot' } }
    })

    expect(await reader.getMergeRequestState(9)).toMatchObject({ data: { mergedBy: 'bot' } })
  })

  it('reads approvals and skips entries without a username', async () => {
    const { reader, paths } = readerFor({
      '/merge_requests/7/approvals': {
        approved: true,
        approved_by: [{ user: { id: 1, username: 'ada' } }, { user: {} }, {}, 'junk'],
        user_can_approve: false,
        user_has_approved: true
      },
      '/merge_requests/8/approvals': {}
    })

    expect(await reader.getMergeRequestApprovals(7)).toEqual({
      ok: true,
      complete: true,
      data: { approved: true, approvedBy: ['ada'], userHasApproved: true }
    })
    expect(await reader.getMergeRequestApprovals(8)).toEqual({
      ok: true,
      complete: true,
      data: { approved: null, approvedBy: [], userHasApproved: null }
    })
    expect(paths).toEqual(['/merge_requests/7/approvals', '/merge_requests/8/approvals'])
  })

  it('refuses an unusable iid and a response without a state', async () => {
    const { reader, paths } = readerFor({ '/merge_requests/7': { iid: 7 } })

    expect(await reader.getMergeRequestState(0)).toEqual({ ok: false, code: 'bad-response' })
    expect(await reader.getMergeRequestApprovals(-1)).toEqual({ ok: false, code: 'bad-response' })
    expect(await reader.getMergeRequestState(7)).toEqual({ ok: false, code: 'bad-response' })
    expect(paths).toEqual(['/merge_requests/7'])
  })

  it('passes a failed read through unchanged', async () => {
    const { reader } = readerFor({})

    expect(await reader.getMergeRequestState(5)).toEqual({ ok: false, code: 'not-found' })
  })

  it('exposes no method that could write', () => {
    const { reader } = readerFor({})

    expect(Object.keys(reader).sort()).toEqual([
      'getCurrentUser',
      'getMergeRequestApprovals',
      'getMergeRequestState',
      'listIssueNotes',
      'listMergeRequestNotes'
    ])
  })

  it('reaches GitLab only through glab api GET routes of the bound project', async () => {
    const calls: string[][] = []
    const bodies: Record<string, unknown> = {
      user: { name: 'Ada', username: 'ada' },
      'projects/3/merge_requests/7': { iid: 7, state: 'opened', sha: null },
      'projects/3/merge_requests/7/approvals': { approved: false, approved_by: [] },
      'projects/3/merge_requests/7/notes?order_by=created_at&sort=desc&per_page=100&page=1': [],
      'projects/3/issues/9/notes?order_by=created_at&sort=desc&per_page=100&page=1': []
    }
    const reader = createGlabDispatchConfirmationReaderFactory(async (args) => {
      calls.push(args)
      const route = args.at(-1) ?? ''
      const body = bodies[route] ?? bodies[route.split('?')[0] ?? '']
      return {
        stdout: `HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body ?? {})}`,
        stderr: ''
      }
    })({ gitlabHost: 'gitlab.test', repoPath: '/repo', gitlabProjectId: 3 })

    await reader.getCurrentUser()
    await reader.getMergeRequestState(7)
    await reader.getMergeRequestApprovals(7)
    await reader.listMergeRequestNotes(7)
    await reader.listIssueNotes(9)

    expect(calls).toHaveLength(5)
    for (const args of calls) {
      expect(args.slice(0, 4)).toEqual(['api', '-i', '--hostname', 'gitlab.test'])
      expect(args).toHaveLength(5)
      expect(args.join(' ')).not.toMatch(
        /(^| )(-X|--method|-f|-F|--field|--raw-field|--input)( |$)/
      )
    }
    expect(calls.map((args) => args[4]?.split('?')[0])).toEqual([
      'user',
      'projects/3/merge_requests/7',
      'projects/3/merge_requests/7/approvals',
      'projects/3/merge_requests/7/notes',
      'projects/3/issues/9/notes'
    ])
  })
})

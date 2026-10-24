import { describe, expect, it } from 'vitest'
import type { GitlabApiReader } from './forge-inbox-gitlab-api-client'
import type { GitlabMergeRequest } from './forge-inbox-gitlab-api-schemas'
import { verifyForgePatchTarget } from './forge-inbox-patch-target'

const PROJECT_ID = '42'
const IID = 9
const HEAD = 'a'.repeat(40)
const OTHER_SHA = 'c'.repeat(40)

type TargetReader = Pick<
  GitlabApiReader,
  'getCurrentUser' | 'getMergeRequest' | 'getRepositoryBranchHead'
>

function mergeRequest(overrides: Partial<GitlabMergeRequest> = {}): GitlabMergeRequest {
  return {
    iid: IID,
    state: 'opened',
    title: 'Add thing',
    description: '',
    target_branch: 'main',
    source_branch: 'feature/work',
    source_project_id: 42,
    target_project_id: 42,
    draft: false,
    sha: HEAD,
    diff_refs: { base_sha: 'b'.repeat(40), head_sha: HEAD, start_sha: 'b'.repeat(40) },
    author: 'alice',
    reviewers: [],
    assignees: [],
    updated_at: '2026-01-01T00:00:00Z',
    headPipeline: null,
    ...overrides
  }
}

function reader(overrides: Partial<TargetReader> = {}): TargetReader {
  return {
    getCurrentUser: async () => ({
      ok: true,
      data: { name: 'Bot', username: 'bot', email: null, commit_email: null },
      complete: true
    }),
    getMergeRequest: async () => ({ ok: true, data: mergeRequest(), complete: true }),
    getRepositoryBranchHead: async (branch) => ({
      ok: true,
      data: { branch, sha: HEAD },
      complete: true
    }),
    ...overrides
  }
}

function verify(overrides: Partial<TargetReader> = {}) {
  return verifyForgePatchTarget({ reader: reader(overrides), projectId: PROJECT_ID, iid: IID })
}

describe('forge patch target verification', () => {
  it('accepts a merge request whose branch head still matches its diff head', async () => {
    await expect(verify()).resolves.toEqual({ ok: true, branch: 'feature/work', headSha: HEAD })
  })

  it('refuses a fork whose source project is not the configured project', async () => {
    await expect(
      verify({
        getMergeRequest: async () => ({
          ok: true,
          data: mergeRequest({ source_project_id: 43 }),
          complete: true
        })
      })
    ).resolves.toEqual({ ok: false, reason: 'target-identity' })
  })

  it('refuses a merge request that targets another project', async () => {
    await expect(
      verify({
        getMergeRequest: async () => ({
          ok: true,
          data: mergeRequest({ target_project_id: 43 }),
          complete: true
        })
      })
    ).resolves.toEqual({ ok: false, reason: 'target-identity' })
  })

  it('refuses a merge request whose iid does not match the request', async () => {
    await expect(
      verify({
        getMergeRequest: async () => ({
          ok: true,
          data: mergeRequest({ iid: IID + 1 }),
          complete: true
        })
      })
    ).resolves.toEqual({ ok: false, reason: 'target-identity' })
  })

  it('refuses a head sha that is not the diff head', async () => {
    await expect(
      verify({
        getMergeRequest: async () => ({
          ok: true,
          data: mergeRequest({ sha: OTHER_SHA }),
          complete: true
        })
      })
    ).resolves.toEqual({ ok: false, reason: 'target-head' })
  })

  it('refuses a non-hex head sha', async () => {
    await expect(
      verify({
        getMergeRequest: async () => ({
          ok: true,
          data: mergeRequest({ sha: 'not-a-sha' }),
          complete: true
        })
      })
    ).resolves.toEqual({ ok: false, reason: 'target-head' })
  })

  it('refuses a merge request with no diff refs', async () => {
    await expect(
      verify({
        getMergeRequest: async () => ({
          ok: true,
          data: mergeRequest({ diff_refs: null }),
          complete: true
        })
      })
    ).resolves.toEqual({ ok: false, reason: 'target-head' })
  })

  it('refuses when the branch head moved past the diff head', async () => {
    await expect(
      verify({
        getRepositoryBranchHead: async (branch) => ({
          ok: true,
          data: { branch, sha: OTHER_SHA },
          complete: true
        })
      })
    ).resolves.toEqual({ ok: false, reason: 'target-head' })
  })

  it('refuses a missing source branch', async () => {
    await expect(
      verify({
        getMergeRequest: async () => ({
          ok: true,
          data: mergeRequest({ source_branch: null }),
          complete: true
        })
      })
    ).resolves.toEqual({ ok: false, reason: 'target-branch' })
  })

  it('refuses a source branch that is not a well-formed ref', async () => {
    await expect(
      verify({
        getMergeRequest: async () => ({
          ok: true,
          data: mergeRequest({ source_branch: 'feature//work' }),
          complete: true
        })
      })
    ).resolves.toEqual({ ok: false, reason: 'target-branch' })
  })

  it('refuses a source branch longer than 255 bytes', async () => {
    await expect(
      verify({
        getMergeRequest: async () => ({
          ok: true,
          data: mergeRequest({ source_branch: 'x'.repeat(256) }),
          complete: true
        })
      })
    ).resolves.toEqual({ ok: false, reason: 'target-branch' })
  })

  it('reports an API failure as an unavailable target', async () => {
    await expect(
      verify({ getCurrentUser: async () => ({ ok: false, code: 'network' }) })
    ).resolves.toEqual({ ok: false, reason: 'target-unavailable' })
  })

  it('reports an incomplete merge request read as an unavailable target', async () => {
    await expect(
      verify({
        getMergeRequest: async () => ({ ok: true, data: mergeRequest(), complete: false })
      })
    ).resolves.toEqual({ ok: false, reason: 'target-unavailable' })
  })

  it('reports an unreadable branch head as an unavailable target', async () => {
    await expect(
      verify({ getRepositoryBranchHead: async () => ({ ok: false, code: 'not-found' }) })
    ).resolves.toEqual({ ok: false, reason: 'target-unavailable' })
  })
})

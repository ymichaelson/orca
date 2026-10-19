import { describe, expect, it, vi } from 'vitest'
import {
  listGitLabClosedReviewItems,
  listGitLabReviewItems,
  type GitLabApiRunner
} from './gitlab-source'
import { resolveReviewNotificationEvents } from '../../shared/review-notification-types'

const provider = {
  kind: 'gitlab' as const,
  enabled: true,
  baseUrl: 'https://gitlab.example.com',
  projectId: 42,
  events: resolveReviewNotificationEvents(undefined)
}

const mrFixture = [
  {
    iid: 7,
    title: 'Add search',
    web_url: 'https://gitlab.example.com/group/proj/-/merge_requests/7',
    author: { username: 'alice' },
    updated_at: '2026-10-19T10:00:00Z',
    draft: false,
    merge_status: 'can_be_merged',
    labels: ['review-needed'],
    reviewers: [{ username: 'bob' }],
    description: 'Adds full-text search.'
  }
]

const issueFixture = [
  {
    iid: 3,
    title: 'Crash on login',
    web_url: 'https://gitlab.example.com/group/proj/-/issues/3',
    author: { username: 'carol' },
    updated_at: '2026-10-19T09:00:00Z',
    labels: [],
    description: 'Steps to reproduce...'
  }
]

function runnerFor(mrs: unknown[], issues: unknown[]): GitLabApiRunner {
  return vi.fn(async (path: string) => {
    if (path.includes('/merge_requests')) {
      return mrs
    }
    if (path.includes('/issues')) {
      return issues
    }
    throw new Error(`unexpected path ${path}`)
  })
}

describe('gitlab-source', () => {
  it('normalizes MR and issue lists into review events', async () => {
    const { mrs, issues } = await listGitLabReviewItems(
      provider,
      { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
      runnerFor(mrFixture, issueFixture)
    )
    expect(mrs).toHaveLength(1)
    expect(mrs[0]).toMatchObject({
      provider: 'gitlab',
      host: 'gitlab.example.com',
      kind: 'mr',
      iid: 7,
      actor: 'alice',
      title: 'Add search'
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'issue', iid: 3, actor: 'carol' })
  })

  it('skips items with unusable iids', async () => {
    const { mrs } = await listGitLabReviewItems(
      provider,
      { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
      runnerFor([{ ...mrFixture[0], iid: 'nope' }], [])
    )
    expect(mrs).toHaveLength(0)
  })

  it('classifies 401 as auth and 429 as rate_limited', async () => {
    const authRunner: GitLabApiRunner = async () => {
      throw Object.assign(new Error('glab: ERROR: http 401: Unauthorized'), {
        stderr: 'ERROR: http 401: Unauthorized'
      })
    }
    await expect(
      listGitLabReviewItems(
        provider,
        { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
        authRunner
      )
    ).rejects.toMatchObject({ kind: 'auth' })
    const rateRunner: GitLabApiRunner = async () => {
      throw Object.assign(new Error('429 Too Many Requests'), {
        stderr: 'ERROR: http 429: Too Many Requests'
      })
    }
    await expect(
      listGitLabReviewItems(
        provider,
        { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
        rateRunner
      )
    ).rejects.toMatchObject({ kind: 'rate_limited' })
  })

  it('rejects non-https baseUrl unless insecureHttp is set', async () => {
    const httpProvider = { ...provider, baseUrl: 'http://gitlab.internal' }
    await expect(
      listGitLabReviewItems(
        httpProvider,
        { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
        runnerFor([], [])
      )
    ).rejects.toMatchObject({ kind: 'network' })
    const insecure = { ...httpProvider, insecureHttp: true }
    const { mrs } = await listGitLabReviewItems(
      insecure,
      { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
      runnerFor([], [])
    )
    expect(mrs).toHaveLength(0)
  })

  it('passes updated_after and hostname-qualified paths to glab api', async () => {
    const runner = runnerFor([], [])
    await listGitLabReviewItems(
      provider,
      { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
      runner
    )
    const paths = runner.mock.calls.map((call) => call[0])
    expect(paths.some((p) => p.includes('projects/42/merge_requests'))).toBe(true)
    expect(paths.some((p) => p.includes('updated_after='))).toBe(true)
  })

  it('lists closed and merged MRs plus closed issues for resolve detection', async () => {
    const closedMr = { ...mrFixture[0], iid: 7 }
    const mergedMr = { ...mrFixture[0], iid: 8, title: 'Merged work' }
    const closedIssue = { ...issueFixture[0], iid: 3 }
    const runner: GitLabApiRunner = vi.fn(async (path: string) => {
      if (path.includes('/merge_requests') && path.includes('state=closed')) {
        return [closedMr]
      }
      if (path.includes('/merge_requests') && path.includes('state=merged')) {
        return [mergedMr]
      }
      if (path.includes('/issues')) {
        expect(path).toContain('state=closed')
        return [closedIssue]
      }
      throw new Error(`unexpected path ${path}`)
    })
    const { mrs, issues } = await listGitLabClosedReviewItems(
      provider,
      { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
      runner
    )
    expect(mrs.map((m) => m.iid).sort()).toEqual([7, 8])
    expect(mrs.every((m) => m.kind === 'mr')).toBe(true)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'issue', iid: 3 })
  })

  it('queries MR and issue endpoints with their own cursors', async () => {
    const runner = runnerFor([], [])
    await listGitLabReviewItems(
      provider,
      { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T09:00:00Z' },
      runner
    )
    const paths: string[] = runner.mock.calls.map((call) => call[0])
    const mrPath = paths.find((p) => p.includes('/merge_requests'))
    const issuePath = paths.find((p) => p.includes('/issues'))
    expect(mrPath).toContain('updated_after=2026-10-19T08%3A00%3A00Z')
    expect(issuePath).toContain('updated_after=2026-10-19T09%3A00%3A00Z')
  })

  it('follows full pages instead of stopping at per_page', async () => {
    const allMrs = Array.from({ length: 120 }, (_, i) => ({
      ...mrFixture[0],
      iid: i + 1,
      updated_at: `2026-10-19T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`
    }))
    let calls = 0
    const pagingRunner: GitLabApiRunner = vi.fn(async (path: string) => {
      calls++
      if (!path.includes('/merge_requests')) {
        return []
      }
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? '1')
      const start = (page - 1) * 50
      return allMrs.slice(start, start + 50)
    })
    const { mrs } = await listGitLabReviewItems(
      provider,
      { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
      pagingRunner
    )
    expect(mrs).toHaveLength(120)
    // MRs: 50 + 50 + 20, stopping at the first short page; issues: 1 short page.
    expect(calls).toBe(4)
    expect(mrs.map((m) => m.iid)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1))
  })

  it('caps pagination at ten pages per endpoint', async () => {
    let calls = 0
    const endlessRunner: GitLabApiRunner = vi.fn(async (path: string) => {
      calls++
      if (!path.includes('/merge_requests')) {
        return []
      }
      return Array.from({ length: 50 }, (_, i) => ({ ...mrFixture[0], iid: calls * 100 + i }))
    })
    const { mrs } = await listGitLabReviewItems(
      provider,
      { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
      endlessRunner
    )
    // 10 pages for the MR endpoint, 1 short page for issues.
    expect(calls).toBe(11)
    expect(mrs).toHaveLength(500)
  })

  it('paginates the closed listings too', async () => {
    const closedMrs = Array.from({ length: 60 }, (_, i) => ({ ...mrFixture[0], iid: i + 1 }))
    const pagingRunner: GitLabApiRunner = vi.fn(async (path: string) => {
      if (!path.includes('state=closed') || !path.includes('/merge_requests')) {
        return []
      }
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? '1')
      return closedMrs.slice((page - 1) * 50, page * 50)
    })
    const { mrs } = await listGitLabClosedReviewItems(
      provider,
      { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
      pagingRunner
    )
    expect(mrs).toHaveLength(60)
  })
})

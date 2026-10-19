import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  listGitHubClosedReviewItems,
  listGitHubReviewItems,
  parseSlurpedPages,
  type GitHubApiRunner,
  type GitHubPageRunner
} from './github-source'
import { resolveReviewNotificationEvents } from '../../shared/review-notification-types'

const provider = {
  kind: 'github' as const,
  enabled: true,
  owner: 'octocat',
  repo: 'hello-world',
  events: resolveReviewNotificationEvents(undefined)
}

const prFixture = [
  {
    number: 45,
    title: 'Fix race',
    html_url: 'https://github.com/octocat/hello-world/pull/45',
    user: { login: 'alice' },
    updated_at: '2026-10-19T10:00:00Z',
    draft: false
  }
]

const issueFixture = [
  {
    number: 46,
    title: 'Docs typo',
    html_url: 'https://github.com/octocat/hello-world/issues/46',
    user: { login: 'carol' },
    updated_at: '2026-10-19T09:00:00Z'
  },
  // The issues endpoint also returns PRs; they must be filtered out.
  {
    number: 45,
    title: 'Fix race',
    html_url: 'https://github.com/octocat/hello-world/pull/45',
    user: { login: 'alice' },
    updated_at: '2026-10-19T10:00:00Z',
    pull_request: { url: 'https://api.github.com/repos/octocat/hello-world/pulls/45' }
  }
]

function runnerFor(prs: unknown[], issues: unknown[]): GitHubApiRunner {
  return vi.fn(async (endpoint: string) => {
    if (endpoint.includes('/pulls')) {
      return prs
    }
    if (endpoint.includes('/issues')) {
      return issues
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  })
}

function pageRunnerFor(prs: unknown[]): Mock<GitHubPageRunner> {
  return vi.fn(async (endpoint: string) => {
    if (endpoint.includes('/pulls')) {
      return prs
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  })
}

describe('github-source', () => {
  it('normalizes PRs to kind mr and filters PRs out of the issues list', async () => {
    const { mrs, issues } = await listGitHubReviewItems(
      provider,
      { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
      runnerFor([], issueFixture),
      pageRunnerFor(prFixture)
    )
    expect(mrs).toHaveLength(1)
    expect(mrs[0]).toMatchObject({
      provider: 'github',
      host: 'github.com',
      repo: 'octocat/hello-world',
      kind: 'mr',
      iid: 45,
      actor: 'alice'
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'issue', iid: 46 })
  })

  it('classifies 403 as auth and rate-limit text as rate_limited', async () => {
    const authRunner: GitHubApiRunner = async () => {
      throw Object.assign(new Error('403 Forbidden'), { stderr: 'HTTP 403: Forbidden' })
    }
    const authPageRunner: GitHubPageRunner = async () => {
      throw Object.assign(new Error('403 Forbidden'), { stderr: 'HTTP 403: Forbidden' })
    }
    await expect(
      listGitHubReviewItems(
        provider,
        { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
        authRunner,
        authPageRunner
      )
    ).rejects.toMatchObject({ kind: 'auth' })
    const rateRunner: GitHubApiRunner = async () => {
      throw Object.assign(new Error('abuse'), {
        stderr: 'You have exceeded a secondary rate limit'
      })
    }
    const ratePageRunner: GitHubPageRunner = async () => {
      throw Object.assign(new Error('abuse'), {
        stderr: 'You have exceeded a secondary rate limit'
      })
    }
    await expect(
      listGitHubReviewItems(
        provider,
        { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
        rateRunner,
        ratePageRunner
      )
    ).rejects.toMatchObject({ kind: 'rate_limited' })
  })

  it('pages PRs newest-first and passes since on the issues endpoint', async () => {
    const runner = runnerFor([], [])
    const pageRunner = pageRunnerFor([])
    await listGitHubReviewItems(
      provider,
      { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
      runner,
      pageRunner
    )
    const pullEndpoints = pageRunner.mock.calls.map((c) => c[0])
    expect(pullEndpoints.some((e) => e.includes('repos/octocat/hello-world/pulls'))).toBe(true)
    expect(pullEndpoints.every((e) => !e.includes('since='))).toBe(true)
    const issueEndpoints = runner.mock.calls.map((c) => c[0])
    expect(issueEndpoints.some((e) => e.includes('repos/octocat/hello-world/issues'))).toBe(true)
    expect(issueEndpoints.some((e) => e.includes('since='))).toBe(true)
  })

  it('classifies a 403 secondary rate limit as rate_limited, not auth', async () => {
    const runner: GitHubApiRunner = async () => {
      throw Object.assign(new Error('403'), {
        stderr: 'HTTP 403: You have exceeded a secondary rate limit.\nRetry-After: 60'
      })
    }
    await expect(
      listGitHubReviewItems(
        provider,
        { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
        runner
      )
    ).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60000 })
  })

  it('parseSlurpedPages flattens --paginate --slurp output into one item array', () => {
    const page1 = [{ number: 1 }]
    const page2 = [{ number: 2 }, { number: 3 }]
    expect(parseSlurpedPages(JSON.stringify([page1, page2]))).toEqual([...page1, ...page2])
    // A single page stays a single array.
    expect(parseSlurpedPages(JSON.stringify([page1]))).toEqual(page1)
    // Non-array output degrades to empty rather than throwing downstream.
    expect(parseSlurpedPages(JSON.stringify({}))).toEqual([])
  })

  it('queries the closed endpoint with the older of the two cursors', async () => {
    const seen: string[] = []
    const runner: GitHubApiRunner = vi.fn(async (endpoint: string) => {
      seen.push(endpoint)
      return []
    })
    await listGitHubClosedReviewItems(
      provider,
      { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T09:00:00Z' },
      runner
    )
    expect(seen).toHaveLength(1)
    // Older cursor wins so neither kind's window is skipped.
    expect(seen[0]).toContain('since=2026-10-19T08%3A00%3A00Z')
  })

  it('queries the issues endpoint with its own cursor; pulls page newest-first', async () => {
    const seen: string[] = []
    const runner: GitHubApiRunner = vi.fn(async (endpoint: string) => {
      seen.push(endpoint)
      return []
    })
    const pageRunner: GitHubPageRunner = vi.fn(async (endpoint: string) => {
      seen.push(endpoint)
      return []
    })
    await listGitHubReviewItems(
      provider,
      { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T09:00:00Z' },
      runner,
      pageRunner
    )
    const pulls = seen.find((e) => e.includes('/pulls'))
    const issues = seen.find((e) => e.includes('/issues'))
    // The pulls endpoint ignores `since`: it is paged newest-first instead.
    expect(pulls).toContain('sort=updated')
    expect(pulls).toContain('direction=desc')
    expect(pulls).not.toContain('since=')
    expect(issues).toContain('since=2026-10-19T09%3A00%3A00Z')
  })

  it('stops pulling pages once PRs are older than the cursor floor', async () => {
    const pr = (n: number, updatedAt: string) => ({
      number: n,
      title: `PR ${n}`,
      html_url: `https://github.com/octocat/hello-world/pull/${n}`,
      user: { login: 'alice' },
      updated_at: updatedAt,
      draft: false
    })
    // Newest-first: page 1 is full and all newer than the floor, page 2
    // straddles it, so paging must stop mid-page-2 at the older item.
    const page1 = Array.from({ length: 50 }, (_, i) => pr(100 + i, '2026-10-19T10:30:00Z'))
    const page2 = [
      pr(3, '2026-10-19T10:20:00Z'),
      pr(2, '2026-10-19T10:10:00Z'),
      pr(1, '2026-10-19T07:00:00Z')
    ]
    const pages: Record<number, unknown[]> = { 1: page1, 2: page2 }
    let calls = 0
    const pageRunner: GitHubPageRunner = vi.fn(async (endpoint: string) => {
      calls++
      const page = Number(new URLSearchParams(endpoint.split('?')[1]).get('page') ?? '1')
      return pages[page] ?? []
    })
    const { mrs } = await listGitHubReviewItems(
      provider,
      { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
      runnerFor([], []),
      pageRunner
    )
    // Floor is mrSince minus the 60s overlap: 07:59. PR 1 (07:00) is excluded.
    expect(mrs).toHaveLength(52)
    expect(mrs.some((m) => m.iid === 1)).toBe(false)
    expect(calls).toBe(2)
  })

  it('lists closed PRs and issues for resolve detection', async () => {
    const closedPr = {
      number: 45,
      title: 'Fix race',
      html_url: 'https://github.com/octocat/hello-world/pull/45',
      user: { login: 'alice' },
      updated_at: '2026-10-19T10:30:00Z',
      pull_request: { url: 'https://api.github.com/repos/octocat/hello-world/pulls/45' }
    }
    const closedIssue = {
      number: 46,
      title: 'Docs typo',
      html_url: 'https://github.com/octocat/hello-world/issues/46',
      user: { login: 'carol' },
      updated_at: '2026-10-19T10:31:00Z'
    }
    const runner: GitHubApiRunner = vi.fn(async (endpoint: string) => {
      expect(endpoint).toContain('state=closed')
      return [closedPr, closedIssue]
    })
    const { mrs, issues } = await listGitHubClosedReviewItems(
      provider,
      { mrSince: '2026-10-19T08:00:00Z', issueSince: '2026-10-19T08:00:00Z' },
      runner
    )
    expect(mrs).toHaveLength(1)
    expect(mrs[0]).toMatchObject({ kind: 'mr', iid: 45 })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'issue', iid: 46 })
  })
})

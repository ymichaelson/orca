import { extractExecError } from '../git/exec-error'
import { ghExecFileAsync } from '../git/command-runner/gh-exec-file'
import type { GitHubReviewNotificationProvider } from '../../shared/review-notification-types'
import { skewBack } from './dedup'
import type { ReviewEvent, ReviewListingCursors } from './review-event'

export type GitHubSourceError = {
  kind: 'auth' | 'rate_limited' | 'network' | 'parse'
  retryAfterMs?: number
  message: string
}

/** Injected for tests; production uses ghExecFileAsync. */
export type GitHubApiRunner = (
  endpoint: string,
  provider: GitHubReviewNotificationProvider
) => Promise<unknown>

/**
 * Single-page runner for endpoints needing manual pagination: the pulls
 * endpoint ignores `since`, so it is paged newest-first with a stop condition
 * instead of `--paginate`.
 */
export type GitHubPageRunner = (
  endpoint: string,
  provider: GitHubReviewNotificationProvider
) => Promise<unknown[]>

export function createGitHubPageRunner(): GitHubPageRunner {
  return async (endpoint) => {
    const { stdout } = await ghExecFileAsync(['api', endpoint, '--method', 'GET'])
    const parsed: unknown = JSON.parse(stdout)
    return Array.isArray(parsed) ? parsed : []
  }
}

function classifyError(error: unknown): GitHubSourceError {
  const { stderr } = extractExecError(error)
  const text = stderr.toLowerCase()
  // Rate limits first: GitHub reports secondary rate limits as HTTP 403.
  const rateLimited =
    /\b429\b/.test(text) || /rate limit|secondary rate limit|abuse detection/i.test(text)
  if (rateLimited) {
    const retryAfter = text.match(/retry-after[:\s]+(\d+)/i)
    return {
      kind: 'rate_limited',
      retryAfterMs: retryAfter ? Number(retryAfter[1]) * 1000 : undefined,
      message: 'GitHub rate limit hit.'
    }
  }
  if (/\b(401|403)\b/.test(text)) {
    return { kind: 'auth', message: 'GitHub authentication failed (401/403). Check the gh token.' }
  }
  return { kind: 'network', message: stderr.slice(0, 200) || 'GitHub request failed.' }
}

/**
 * Parse `gh api --paginate --slurp` output: one outer array holding each
 * page's array. Without --slurp, pagination emits multiple concatenated JSON
 * values and JSON.parse fails past the first page.
 */
export function parseSlurpedPages(stdout: string): unknown[] {
  const parsed: unknown = JSON.parse(stdout)
  if (!Array.isArray(parsed)) {
    return []
  }
  return parsed.flatMap((page) => (Array.isArray(page) ? page : [page]))
}

/**
 * Read-only: uses `gh api` (poll/read scopes only). github.com only in 1a;
 * GitHub Enterprise support is a fast follow-up.
 */
export function createGitHubApiRunner(): GitHubApiRunner {
  return async (endpoint) => {
    // Absolute API path carries the repo; default gh auth applies (github.com in 1a).
    const { stdout } = await ghExecFileAsync([
      'api',
      endpoint,
      '--paginate',
      '--slurp',
      '--method',
      'GET'
    ])
    return parseSlurpedPages(stdout)
  }
}

type GitHubItem = {
  number: number
  title: string
  html_url: string
  user?: { login?: string }
  updated_at: string
  draft?: boolean
  pull_request?: unknown
  labels?: { name?: string }[]
  requested_reviewers?: { login?: string }[]
}

function toEvent(
  raw: Record<string, unknown>,
  kind: 'mr' | 'issue',
  provider: GitHubReviewNotificationProvider
): ReviewEvent | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forge JSON boundary; every field is narrowed with ??/String()/Number() before use.
  const item = raw as Partial<GitHubItem>
  const number = Number(item.number)
  if (!Number.isFinite(number)) {
    return null
  }
  return {
    provider: 'github',
    host: 'github.com',
    repo: `${provider.owner}/${provider.repo}`,
    kind,
    action: 'opened',
    iid: number,
    actor: item.user?.login ?? '',
    title: String(item.title ?? ''),
    url: String(item.html_url ?? ''),
    updatedAt: String(item.updated_at ?? ''),
    meta: {
      draft: item.draft,
      labels: (item.labels ?? []).map((l) => String(l.name ?? '')).filter(Boolean),
      reviewers: (item.requested_reviewers ?? []).map((r) => String(r.login ?? '')).filter(Boolean)
    }
  }
}

/**
 * List PRs/issues closed since the per-kind cursors (read-only). The issues
 * endpoint returns closed PRs too; items carrying `pull_request` map to kind
 * 'mr'. One endpoint serves both kinds, so it is queried with the older of the
 * two cursors and the results are split; each cursor still advances only from
 * its own kind. Used only to resolve open notifications: these items are
 * confirmed gone, unlike the delta open listing where an item's absence proves
 * nothing.
 */
export async function listGitHubClosedReviewItems(
  provider: GitHubReviewNotificationProvider,
  cursors: ReviewListingCursors,
  runner: GitHubApiRunner = createGitHubApiRunner()
): Promise<{ mrs: ReviewEvent[]; issues: ReviewEvent[] }> {
  const slug = `${provider.owner}/${provider.repo}`
  const since = cursors.mrSince < cursors.issueSince ? cursors.mrSince : cursors.issueSince
  const query = `?state=closed&sort=updated&direction=asc&per_page=50&since=${encodeURIComponent(since)}`
  try {
    const raw = await runner(`repos/${slug}/issues${query}`, provider)
    const mrs: ReviewEvent[] = []
    const issues: ReviewEvent[] = []
    for (const r of Array.isArray(raw) ? raw : []) {
      if (typeof r !== 'object' || r === null) {
        continue
      }
      const isPr = 'pull_request' in r
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forge JSON boundary; toEvent narrows every field before use.
      const event = toEvent(r as Record<string, unknown>, isPr ? 'mr' : 'issue', provider)
      if (event) {
        if (isPr) {
          mrs.push(event)
        } else {
          issues.push(event)
        }
      }
    }
    return { mrs, issues }
  } catch (error) {
    if (error && typeof error === 'object' && 'kind' in error) {
      throw error
    }
    throw classifyError(error)
  }
}

const GH_PER_PAGE = 50
const GH_MAX_PAGES = 10

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function updatedAtMillis(raw: Record<string, unknown>): number {
  const ts = Date.parse(String(raw.updated_at ?? ''))
  return Number.isFinite(ts) ? ts : Number.NaN
}

/**
 * The pulls endpoint ignores `since`: page newest-first and stop once a page
 * reaches the overlap floor. The 60s skew stays as the tie-breaker for
 * second-precision timestamps, not as the pagination mechanism.
 */
async function fetchOpenPulls(
  pageRunner: GitHubPageRunner,
  slug: string,
  mrSince: string,
  provider: GitHubReviewNotificationProvider
): Promise<Record<string, unknown>[]> {
  const floor = Date.parse(skewBack(mrSince))
  const out: Record<string, unknown>[] = []
  for (let page = 1; page <= GH_MAX_PAGES; page++) {
    const batch = await pageRunner(
      `repos/${slug}/pulls?state=open&sort=updated&direction=desc&per_page=${GH_PER_PAGE}&page=${page}`,
      provider
    )
    let done = batch.length < GH_PER_PAGE
    for (const raw of batch) {
      if (!isRecord(raw)) {
        continue
      }
      const ts = updatedAtMillis(raw)
      if (Number.isNaN(ts) || ts > floor) {
        out.push(raw)
      } else {
        // Newest-first: everything from here on is older than the floor.
        done = true
        break
      }
    }
    if (done) {
      break
    }
  }
  return out
}

/**
 * List open PRs and issues updated since the per-kind cursors (read-only).
 * The issues endpoint returns PRs too; they are filtered out.
 */
export async function listGitHubReviewItems(
  provider: GitHubReviewNotificationProvider,
  cursors: ReviewListingCursors,
  runner: GitHubApiRunner = createGitHubApiRunner(),
  pageRunner: GitHubPageRunner = createGitHubPageRunner()
): Promise<{ mrs: ReviewEvent[]; issues: ReviewEvent[] }> {
  const slug = `${provider.owner}/${provider.repo}`
  const issueSince = `?state=open&sort=updated&direction=asc&per_page=50&since=${encodeURIComponent(cursors.issueSince)}`
  try {
    const [prRaws, issueRaw] = await Promise.all([
      fetchOpenPulls(pageRunner, slug, cursors.mrSince, provider),
      runner(`repos/${slug}/issues${issueSince}`, provider)
    ])
    const mrs = prRaws
      .map((r) => toEvent(r, 'mr', provider))
      .filter((e): e is ReviewEvent => e !== null)
    const issues = (Array.isArray(issueRaw) ? issueRaw : [])
      .filter((r) => typeof r === 'object' && r !== null && !('pull_request' in r))
      .map((r) => toEvent(r, 'issue', provider))
      .filter((e): e is ReviewEvent => e !== null)
    return { mrs, issues }
  } catch (error) {
    if (error && typeof error === 'object' && 'kind' in error) {
      throw error
    }
    throw classifyError(error)
  }
}

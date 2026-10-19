import { extractExecError } from '../git/exec-error'
import { glabExecFileAsync } from '../git/command-runner/glab-exec-file'
import type { GitLabReviewNotificationProvider } from '../../shared/review-notification-types'
import type { ReviewEvent, ReviewListingCursors } from './review-event'

/**
 * Raw list items returned by the GitLab source before transition
 * classification. `updatedAt` is the provider's ISO timestamp.
 */
export type GitLabListItem = {
  iid: number
  title: string
  webUrl: string
  authorUsername: string
  updatedAt: string
  draft: boolean
  mergeStatus: string
  labels: string[]
  reviewers: string[]
  descriptionExcerpt: string
}

export type GitLabSourceError = {
  kind: 'auth' | 'rate_limited' | 'network' | 'parse'
  retryAfterMs?: number
  message: string
}

/** Injected for tests; production uses glabExecFileAsync via glab api. */
export type GitLabApiRunner = (
  path: string,
  provider: GitLabReviewNotificationProvider
) => Promise<unknown>

export function hostnameFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').split('/')[0]
  }
}

function requireHttps(provider: GitLabReviewNotificationProvider): string {
  const raw = provider.baseUrl.trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw { kind: 'network', message: `Invalid GitLab baseUrl: ${raw}` }
  }
  if (url.protocol !== 'https:' && !provider.insecureHttp) {
    throw {
      kind: 'network',
      message: `GitLab baseUrl must be https (got ${url.protocol}); set insecureHttp only for lab environments.`
    }
  }
  return url.hostname
}

function classifyError(error: unknown): GitLabSourceError {
  const { stderr } = extractExecError(error)
  const text = stderr.toLowerCase()
  // Rate limits first: providers may report them as 403.
  const rateLimited = /\b429\b/.test(text) || /rate limit/i.test(text)
  if (rateLimited) {
    const retryAfter = text.match(/retry-after[:\s]+(\d+)/i)
    return {
      kind: 'rate_limited',
      retryAfterMs: retryAfter ? Number(retryAfter[1]) * 1000 : undefined,
      message: 'GitLab rate limit hit (429).'
    }
  }
  if (/\b(401|403)\b/.test(text)) {
    return {
      kind: 'auth',
      message: 'GitLab authentication failed (401/403). Check the glab token.'
    }
  }
  return { kind: 'network', message: stderr.slice(0, 200) || 'GitLab request failed.' }
}

export function createGitLabApiRunner(): GitLabApiRunner {
  return async (path, provider) => {
    const hostname = hostnameFromBaseUrl(provider.baseUrl.trim())
    const { stdout } = await glabExecFileAsync([
      'api',
      path,
      '--hostname',
      hostname,
      '--method',
      'GET'
    ])
    const parsed: unknown = JSON.parse(stdout)
    return parsed
  }
}

function toListItem(raw: Record<string, unknown>): GitLabListItem | null {
  const iid = Number(raw.iid)
  if (!Number.isFinite(iid)) {
    return null
  }
  const author = raw.author
  const authorUsername =
    typeof author === 'object' &&
    author !== null &&
    'username' in author &&
    typeof author.username === 'string'
      ? author.username
      : ''
  const reviewers = Array.isArray(raw.reviewers)
    ? raw.reviewers
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map((r) => String(r.username ?? ''))
    : []
  return {
    iid,
    title: String(raw.title ?? ''),
    webUrl: String(raw.web_url ?? ''),
    authorUsername,
    updatedAt: String(raw.updated_at ?? ''),
    draft: Boolean(raw.draft),
    mergeStatus: String(raw.merge_status ?? ''),
    labels: Array.isArray(raw.labels) ? raw.labels.map(String) : [],
    reviewers,
    descriptionExcerpt: String(raw.description ?? '').slice(0, 300)
  }
}

function toEvent(
  item: GitLabListItem,
  kind: 'mr' | 'issue',
  provider: GitLabReviewNotificationProvider
): ReviewEvent {
  const baseUrl = provider.baseUrl.trim().replace(/\/+$/, '')
  const host = hostnameFromBaseUrl(baseUrl)
  const repo = `${host}/projects/${provider.projectId}`
  const path = kind === 'mr' ? 'merge_requests' : 'issues'
  return {
    provider: 'gitlab',
    host,
    repo,
    kind,
    action: 'opened',
    iid: item.iid,
    actor: item.authorUsername,
    title: item.title,
    url: item.webUrl || `${baseUrl}/-/${path}/${item.iid}`,
    updatedAt: item.updatedAt,
    meta: {
      draft: item.draft,
      labels: item.labels,
      reviewers: item.reviewers
    }
  }
}

function sinceParam(since: string): string {
  return `&updated_after=${encodeURIComponent(since)}`
}

const GITLAB_PER_PAGE = 50
/** Pages fetched per endpoint per poll; 10 pages x 50 items bounds one poll. */
const GITLAB_MAX_PAGES = 10

/**
 * Fetch every page of a GitLab list endpoint (oldest first, sort=asc). A
 * single per_page slice is not enough: when a full page comes back, later
 * pages hold newer items that a cursor advanced from page one would skip.
 * Stops at the first short page; the cap bounds a pathological poll.
 */
async function fetchGitLabPages(
  runner: GitLabApiRunner,
  basePath: string,
  provider: GitLabReviewNotificationProvider
): Promise<unknown[]> {
  const items: unknown[] = []
  for (let page = 1; page <= GITLAB_MAX_PAGES; page++) {
    const raw = await runner(`${basePath}&page=${page}`, provider)
    const batch = Array.isArray(raw) ? raw : []
    items.push(...batch)
    if (batch.length < GITLAB_PER_PAGE) {
      break
    }
  }
  return items
}

/** Forge JSON boundary: keep only object items before mapping. */
function asRecords(raw: unknown[]): Record<string, unknown>[] {
  return raw.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
}

/**
 * List MRs/issues closed or merged since the per-kind cursors (read-only).
 * Used only to resolve open notifications: these items are confirmed gone,
 * unlike the delta open listing where an item's absence proves nothing.
 */
export async function listGitLabClosedReviewItems(
  provider: GitLabReviewNotificationProvider,
  cursors: ReviewListingCursors,
  runner: GitLabApiRunner = createGitLabApiRunner()
): Promise<{ mrs: ReviewEvent[]; issues: ReviewEvent[] }> {
  // Validate before any network call, regardless of the injected runner.
  requireHttps(provider)
  const project = `projects/${provider.projectId}`
  const mrParams = (state: string) =>
    `?state=${state}&order_by=updated_at&sort=asc&per_page=${GITLAB_PER_PAGE}${sinceParam(cursors.mrSince)}`
  const issueParams = (state: string) =>
    `?state=${state}&order_by=updated_at&sort=asc&per_page=${GITLAB_PER_PAGE}${sinceParam(cursors.issueSince)}`
  const toMrs = (raw: unknown[]): ReviewEvent[] =>
    asRecords(raw)
      .map((r) => toListItem(r))
      .filter((i): i is GitLabListItem => i !== null)
      .map((i) => toEvent(i, 'mr', provider))
  try {
    const [closedMrRaw, mergedMrRaw, closedIssueRaw] = await Promise.all([
      fetchGitLabPages(runner, `${project}/merge_requests${mrParams('closed')}`, provider),
      fetchGitLabPages(runner, `${project}/merge_requests${mrParams('merged')}`, provider),
      fetchGitLabPages(runner, `${project}/issues${issueParams('closed')}`, provider)
    ])
    const mrs = [...toMrs(closedMrRaw), ...toMrs(mergedMrRaw)]
    const issues = asRecords(closedIssueRaw)
      .map((r) => toListItem(r))
      .filter((i): i is GitLabListItem => i !== null)
      .map((i) => toEvent(i, 'issue', provider))
    return { mrs, issues }
  } catch (error) {
    if (error && typeof error === 'object' && 'kind' in error) {
      throw error
    }
    throw classifyError(error)
  }
}

/**
 * List open MRs and issues updated since the per-kind cursors (read-only).
 * Errors are classified so the poller can back off quietly.
 */
export async function listGitLabReviewItems(
  provider: GitLabReviewNotificationProvider,
  cursors: ReviewListingCursors,
  runner: GitLabApiRunner = createGitLabApiRunner()
): Promise<{ mrs: ReviewEvent[]; issues: ReviewEvent[] }> {
  // Validate before any network call, regardless of the injected runner.
  requireHttps(provider)
  const project = `projects/${provider.projectId}`
  const mrParams = `?state=opened&order_by=updated_at&sort=asc&per_page=${GITLAB_PER_PAGE}${sinceParam(cursors.mrSince)}`
  const issueParams = `?state=opened&order_by=updated_at&sort=asc&per_page=${GITLAB_PER_PAGE}${sinceParam(cursors.issueSince)}`
  try {
    const [mrRaw, issueRaw] = await Promise.all([
      fetchGitLabPages(runner, `${project}/merge_requests${mrParams}`, provider),
      fetchGitLabPages(runner, `${project}/issues${issueParams}`, provider)
    ])
    const mrs = asRecords(mrRaw)
      .map((r) => toListItem(r))
      .filter((i): i is GitLabListItem => i !== null)
      .map((i) => toEvent(i, 'mr', provider))
    const issues = asRecords(issueRaw)
      .map((r) => toListItem(r))
      .filter((i): i is GitLabListItem => i !== null)
      .map((i) => toEvent(i, 'issue', provider))
    return { mrs, issues }
  } catch (error) {
    if (error && typeof error === 'object' && 'kind' in error) {
      throw error
    }
    throw classifyError(error)
  }
}

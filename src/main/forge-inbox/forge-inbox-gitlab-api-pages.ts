import { z } from 'zod'
import type { GitlabApiRequester, GitlabApiResult } from './forge-inbox-gitlab-api-request'

export const GITLAB_PAGE_SIZE = 100

type PageBudget = { maxPages: number; maxItems: number; maxBytes: number }

type NextPage = { kind: 'done' } | { kind: 'invalid' } | { kind: 'next'; page: number }

function nextPage(header: string | null, current: number, pageItems: number): NextPage {
  if (header === '') {
    return { kind: 'done' }
  }
  // Why: GitLab always sends the header (empty on the last page), so a stripped one on a full page may hide more.
  if (header === null) {
    return pageItems < GITLAB_PAGE_SIZE ? { kind: 'done' } : { kind: 'invalid' }
  }
  // Why: a proxy or hostile server must not be able to loop, skip, or redirect the walk.
  if (!/^[1-9]\d{0,6}$/.test(header) || Number(header) !== current + 1) {
    return { kind: 'invalid' }
  }
  return { kind: 'next', page: Number(header) }
}

/** Walks pages with request numbers we choose; `complete` is false whenever anything was left unread. */
export async function readBoundedPages<T>(
  requester: GitlabApiRequester,
  path: string,
  query: Record<string, string>,
  itemSchema: z.ZodType<T>,
  sizeOf: (item: T) => number,
  budget: PageBudget
): Promise<GitlabApiResult<T[]>> {
  const items: T[] = []
  let bytes = 0
  let page = 1
  for (let fetched = 1; ; fetched += 1) {
    const response = await requester.get(path, {
      ...query,
      per_page: String(GITLAB_PAGE_SIZE),
      page: String(page)
    })
    if (!response.ok) {
      return response
    }
    const parsed = z.array(itemSchema).safeParse(response.json)
    if (!parsed.success) {
      return { ok: false, code: 'bad-response' }
    }
    for (const item of parsed.data) {
      const size = sizeOf(item)
      if (items.length >= budget.maxItems || bytes + size > budget.maxBytes) {
        return { ok: true, data: items, complete: false }
      }
      items.push(item)
      bytes += size
    }
    const next = nextPage(response.headers.get('x-next-page'), page, parsed.data.length)
    if (next.kind === 'done') {
      return { ok: true, data: items, complete: true }
    }
    if (next.kind === 'invalid' || fetched >= budget.maxPages) {
      return { ok: true, data: items, complete: false }
    }
    page = next.page
  }
}

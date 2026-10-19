import { describe, expect, it } from 'vitest'
import { ReviewNotificationPoller, type ReviewPollItem } from './poller'
import { createInMemoryWatermarkStore, watermarkKey } from './dedup'
import type { ReviewEvent } from './review-event'
import {
  resolveReviewNotificationConfig,
  resolveReviewNotificationEvents,
  type ReviewNotificationConfig
} from '../../shared/review-notification-types'

function gitlabConfig(overrides: Partial<ReviewNotificationConfig> = {}): ReviewNotificationConfig {
  return resolveReviewNotificationConfig({
    enabled: true,
    providers: {
      gitlab: {
        kind: 'gitlab',
        enabled: true,
        baseUrl: 'https://gitlab.example.com',
        projectId: 42,
        events: resolveReviewNotificationEvents(undefined)
      }
    },
    ...overrides
  })
}

function mrEvent(overrides: Partial<ReviewEvent> = {}): ReviewEvent {
  return {
    provider: 'gitlab',
    host: 'gitlab.example.com',
    repo: 'gitlab.example.com/projects/42',
    kind: 'mr',
    action: 'opened',
    iid: 7,
    actor: 'alice',
    title: 'Add search',
    url: 'https://gitlab.example.com/-/merge_requests/7',
    updatedAt: '2026-10-19T10:00:00Z',
    ...overrides
  }
}

type Harness = {
  poller: ReviewNotificationPoller
  delivered: ReviewPollItem[][]
  digests: { repoLabel: string; events: ReviewEvent[] }[]
  health: { repoId: string; provider: string; error: string | null }[]
  setListed: (mrs: ReviewEvent[], issues?: ReviewEvent[]) => void
  setClosed: (mrs: ReviewEvent[], issues?: ReviewEvent[]) => void
  setThrow: (error: unknown) => void
}

function makeHarness(
  repos: { id: string; displayName: string; reviewNotifications?: ReviewNotificationConfig }[],
  opts: { globalEnabled?: boolean; maxPerHour?: number } = {}
): Harness {
  const delivered: ReviewPollItem[][] = []
  const digests: { repoLabel: string; events: ReviewEvent[] }[] = []
  const health: { repoId: string; provider: string; error: string | null }[] = []
  let listed: { mrs: ReviewEvent[]; issues: ReviewEvent[] } = { mrs: [], issues: [] }
  let closed: { mrs: ReviewEvent[]; issues: ReviewEvent[] } = { mrs: [], issues: [] }
  let throwError: unknown = null
  const store = createInMemoryWatermarkStore()
  const poller = new ReviewNotificationPoller({
    getRepos: () => repos,
    getGlobalEnabled: () => opts.globalEnabled !== false,
    store,
    delivery: {
      deliver: async (items) => {
        delivered.push(items)
      },
      deliverDigest: async (repoLabel, events) => {
        digests.push({ repoLabel, events })
      }
    },
    now: () => new Date('2026-10-19T12:00:00Z').getTime(),
    random: () => 0.5,
    onHealth: (repoId, provider, error) => {
      health.push({ repoId, provider, error })
    },
    gitlabList: async (_provider, _cursors) => {
      if (throwError) {
        throw throwError
      }
      return listed
    },
    githubList: async () => ({ mrs: [], issues: [] }),
    gitlabListClosed: async (_provider, _cursors) => {
      if (throwError) {
        throw throwError
      }
      return closed
    },
    githubListClosed: async () => ({ mrs: [], issues: [] }),
    setTimeoutFn: () => ({}),
    clearTimeoutFn: () => {}
  })
  poller.reconcile()
  return {
    poller,
    delivered,
    digests,
    health,
    setListed: (mrs, issues = []) => {
      listed = { mrs, issues }
      throwError = null
    },
    setClosed: (mrs, issues = []) => {
      closed = { mrs, issues }
      throwError = null
    },
    setThrow: (error) => {
      throwError = error
    }
  }
}

describe('poller', () => {
  it('notifies on a new MR, then stays silent on push updates', async () => {
    const h = makeHarness([{ id: 'r1', displayName: 'proj', reviewNotifications: gitlabConfig() }])
    h.setListed([mrEvent()])
    const first = await h.poller.pollOnce('r1', 'gitlab')
    expect(first).toHaveLength(1)
    expect(first[0].disposition).toBe('notify')
    expect(first[0].event.action).toBe('opened')
    expect(h.delivered).toHaveLength(1)

    // Same MR with a newer updatedAt (a push): no new notification by default.
    h.setListed([mrEvent({ updatedAt: '2026-10-19T10:05:00Z' })])
    const second = await h.poller.pollOnce('r1', 'gitlab')
    expect(second).toHaveLength(0)
  })

  it('does not re-notify after a restart (fingerprints persist)', async () => {
    const store = createInMemoryWatermarkStore()
    const repos = [{ id: 'r1', displayName: 'proj', reviewNotifications: gitlabConfig() }]
    const mk = () =>
      new ReviewNotificationPoller({
        getRepos: () => repos,
        getGlobalEnabled: () => true,
        store,
        delivery: { deliver: async () => {}, deliverDigest: async () => {} },
        now: () => new Date('2026-10-19T12:00:00Z').getTime(),
        random: () => 0.5,
        gitlabList: async () => ({ mrs: [mrEvent()], issues: [] }),
        githubList: async () => ({ mrs: [], issues: [] }),
        gitlabListClosed: async () => ({ mrs: [], issues: [] }),
        githubListClosed: async () => ({ mrs: [], issues: [] }),
        setTimeoutFn: () => ({}),
        clearTimeoutFn: () => {}
      })
    const first = mk()
    first.reconcile()
    const delivered1: ReviewPollItem[] = []
    // pollOnce uses the harness delivery; emulate by checking returned items.
    const items1 = await first.pollOnce('r1', 'gitlab')
    delivered1.push(...items1)
    expect(delivered1).toHaveLength(1)

    // "Restart": brand-new poller, same persisted store.
    const second = mk()
    second.reconcile()
    const items2 = await second.pollOnce('r1', 'gitlab')
    expect(items2).toHaveLength(0)
  })

  it('backs off quietly on 429 and records health without notifying', async () => {
    const h = makeHarness([{ id: 'r1', displayName: 'proj', reviewNotifications: gitlabConfig() }])
    h.setThrow({ kind: 'rate_limited', message: 'GitLab rate limit hit (429).' })
    const items = await h.poller.pollOnce('r1', 'gitlab')
    expect(items).toHaveLength(0)
    expect(h.delivered).toHaveLength(0)
    expect(h.health.some((x) => x.error !== null)).toBe(true)
  })

  it('does NOT resolve an MR merely absent from the delta listing', async () => {
    const h = makeHarness([{ id: 'r1', displayName: 'proj', reviewNotifications: gitlabConfig() }])
    h.setListed([mrEvent()])
    await h.poller.pollOnce('r1', 'gitlab')
    expect(h.delivered.flat().filter((i) => i.disposition === 'notify')).toHaveLength(1)

    // The delta listing omits unchanged items: no resolve, no re-notify.
    h.setListed([])
    h.setClosed([])
    const items = await h.poller.pollOnce('r1', 'gitlab')
    expect(items).toHaveLength(0)

    // A later push on the same MR is an update, not a new "opened".
    h.setListed([mrEvent({ updatedAt: '2026-10-19T10:05:00Z' })])
    h.setClosed([])
    const items2 = await h.poller.pollOnce('r1', 'gitlab')
    expect(items2.filter((i) => i.disposition === 'notify')).toHaveLength(0)
  })

  it('resolves silently when the closed listing confirms the MR is gone', async () => {
    const h = makeHarness([{ id: 'r1', displayName: 'proj', reviewNotifications: gitlabConfig() }])
    h.setListed([mrEvent()])
    await h.poller.pollOnce('r1', 'gitlab')
    expect(h.delivered).toHaveLength(1)

    h.setListed([])
    h.setClosed([mrEvent({ updatedAt: '2026-10-19T10:30:00Z' })])
    const items = await h.poller.pollOnce('r1', 'gitlab')
    expect(items).toHaveLength(1)
    expect(items[0].disposition).toBe('resolve')
    // The resolve is delivered but never as a user-facing notification.
    expect(items[0].event.action).toBe('closed')
  })

  it('ignores closed-listing entries for items never seen (no snapshot)', async () => {
    const h = makeHarness([{ id: 'r1', displayName: 'proj', reviewNotifications: gitlabConfig() }])
    h.setListed([])
    h.setClosed([mrEvent({ updatedAt: '2026-10-19T10:30:00Z' })])
    const items = await h.poller.pollOnce('r1', 'gitlab')
    expect(items).toHaveLength(0)
  })

  it('groups overflow into a digest past the hourly budget', async () => {
    const h = makeHarness([
      {
        id: 'r1',
        displayName: 'proj',
        reviewNotifications: gitlabConfig({ maxNotificationsPerHour: 1 })
      }
    ])
    h.setListed([mrEvent({ iid: 7 }), mrEvent({ iid: 8, title: 'Other' })])
    await h.poller.pollOnce('r1', 'gitlab')
    const notifies = h.delivered.flat().filter((i) => i.disposition === 'notify')
    expect(notifies).toHaveLength(1)
    expect(h.digests).toHaveLength(1)
    expect(h.digests[0].events).toHaveLength(1)
    expect(h.digests[0].events[0].iid).toBe(8)
  })

  it('regression: absent config means zero behavior change', async () => {
    const h = makeHarness([{ id: 'r1', displayName: 'proj' }])
    const items = await h.poller.pollOnce('r1', 'gitlab')
    expect(items).toHaveLength(0)
    expect(h.delivered).toHaveLength(0)
    expect(h.digests).toHaveLength(0)
    // No jobs were scheduled either.
    h.poller.stop()
  })

  it('regression: global kill-switch disables polling', async () => {
    const h = makeHarness(
      [{ id: 'r1', displayName: 'proj', reviewNotifications: gitlabConfig() }],
      {
        globalEnabled: false
      }
    )
    h.setListed([mrEvent()])
    const items = await h.poller.pollOnce('r1', 'gitlab')
    expect(items).toHaveLength(0)
  })

  it('notifies on watched-label transitions', async () => {
    const config = gitlabConfig()
    config.providers.gitlab!.watchedLabels = ['urgent']
    const h = makeHarness([{ id: 'r1', displayName: 'proj', reviewNotifications: config }])
    h.setListed([mrEvent({ meta: { labels: [] } })])
    await h.poller.pollOnce('r1', 'gitlab')
    expect(h.delivered.flat().filter((i) => i.disposition === 'notify')).toHaveLength(1)

    // A watched label lands: new notification with the labeled action.
    h.setListed([mrEvent({ meta: { labels: ['urgent'] }, updatedAt: '2026-10-19T10:05:00Z' })])
    const items = await h.poller.pollOnce('r1', 'gitlab')
    const notifies = items.filter((i) => i.disposition === 'notify')
    expect(notifies).toHaveLength(1)
    expect(notifies[0].event.action).toBe('labeled')

    // An unwatched label: silent.
    h.setListed([
      mrEvent({ meta: { labels: ['urgent', 'docs'] }, updatedAt: '2026-10-19T10:06:00Z' })
    ])
    const items2 = await h.poller.pollOnce('r1', 'gitlab')
    expect(items2.filter((i) => i.disposition === 'notify')).toHaveLength(0)
  })
})

describe('poller draft transition', () => {
  it('notifies when a draft MR becomes ready for review', async () => {
    const h = makeHarness([{ id: 'r1', displayName: 'proj', reviewNotifications: gitlabConfig() }])
    h.setListed([mrEvent({ meta: { draft: true } })])
    await h.poller.pollOnce('r1', 'gitlab')
    expect(h.delivered.flat().filter((i) => i.disposition === 'notify')).toHaveLength(1)

    h.setListed([mrEvent({ meta: { draft: false }, updatedAt: '2026-10-19T10:05:00Z' })])
    const items = await h.poller.pollOnce('r1', 'gitlab')
    const notifies = items.filter((i) => i.disposition === 'notify')
    expect(notifies).toHaveLength(1)
    expect(notifies[0].event.action).toBe('ready_for_review')
  })
})

describe('poller orphan jobs', () => {
  function makeTimerHarness(
    repos: () => {
      id: string
      displayName: string
      reviewNotifications?: ReviewNotificationConfig
    }[],
    gitlabList: () => Promise<{ mrs: ReviewEvent[]; issues: ReviewEvent[] }>
  ) {
    const timers = new Map<number, () => void>()
    let nextId = 1
    let pollCalls = 0
    const delivered: ReviewPollItem[][] = []
    const store = createInMemoryWatermarkStore()
    const poller = new ReviewNotificationPoller({
      getRepos: repos,
      getGlobalEnabled: () => true,
      store,
      delivery: {
        deliver: async (items) => {
          delivered.push(items)
        },
        deliverDigest: async () => {}
      },
      now: () => Date.now(),
      random: () => 0.5,
      gitlabList: async () => {
        pollCalls += 1
        return gitlabList()
      },
      githubList: async () => ({ mrs: [], issues: [] }),
      gitlabListClosed: async () => ({ mrs: [], issues: [] }),
      githubListClosed: async () => ({ mrs: [], issues: [] }),
      setTimeoutFn: (cb: () => void) => {
        const id = nextId++
        timers.set(id, cb)
        return id
      },
      clearTimeoutFn: (id: unknown) => {
        if (typeof id === 'number') {
          timers.delete(id)
        }
      }
    })
    const fireTimer = (id: number) => {
      const cb = timers.get(id)
      expect(cb).toBeDefined()
      cb!()
    }
    return { poller, timers, delivered, fireTimer, pollCalls: () => pollCalls }
  }

  it('does not reschedule a job removed while its poll is in flight', async () => {
    let repos = [{ id: 'r1', displayName: 'proj', reviewNotifications: gitlabConfig() }]
    let releasePoll!: () => void
    const h = makeTimerHarness(
      () => repos,
      () =>
        new Promise<{ mrs: ReviewEvent[]; issues: ReviewEvent[] }>((r) => {
          releasePoll = () => r({ mrs: [], issues: [] })
        })
    )
    h.poller.start()
    expect(h.timers.size).toBe(1)
    const timerId = [...h.timers.keys()][0]!
    h.fireTimer(timerId)
    // Let the poll reach the hanging source call.
    await new Promise((r) => setImmediate(r))
    expect(h.pollCalls()).toBe(1)
    // Disable the repo mid-poll: the job is removed and its timer cleared.
    repos = []
    h.poller.reconcile()
    // Finish the poll: the finally must not resurrect the removed job.
    releasePoll()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.timers.size).toBe(0)
    expect(h.delivered).toHaveLength(0)
    h.poller.stop()
  })

  it('does not poll or reschedule from a stale retry timer after removal', async () => {
    let repos = [{ id: 'r1', displayName: 'proj', reviewNotifications: gitlabConfig() }]
    const h = makeTimerHarness(
      () => repos,
      async () => {
        throw {
          kind: 'rate_limited',
          retryAfterMs: 60_000,
          message: 'GitLab rate limit hit (429).'
        }
      }
    )
    h.poller.start()
    expect(h.timers.size).toBe(1)
    const firstTimer = [...h.timers.keys()][0]!
    h.fireTimer(firstTimer)
    // Let the poll fail and arm the backoff retry timer.
    await new Promise((r) => setTimeout(r, 20))
    expect(h.pollCalls()).toBe(1)
    expect(h.timers.size).toBe(1)
    const retryTimer = [...h.timers.keys()][0]!
    const retryCb = h.timers.get(retryTimer)!
    // Remove the job while the backoff is pending.
    repos = []
    h.poller.reconcile()
    expect(h.timers.size).toBe(0)
    // The stale retry callback must neither poll nor reschedule.
    retryCb()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.pollCalls()).toBe(1)
    expect(h.timers.size).toBe(0)
    h.poller.stop()
  })
})

describe('poller listing cursors', () => {
  // Sources are fully paginated internally, so the mock returns every item
  // newer than the per-kind cursor (oldest first, like sort=asc).
  function pagedHarness() {
    const nowRef = { now: new Date('2026-10-19T12:00:00Z').getTime() }
    const store = createInMemoryWatermarkStore()
    let openItems: ReviewEvent[] = []
    let closedItems: ReviewEvent[] = []
    let openIssues: ReviewEvent[] = []
    let closedIssues: ReviewEvent[] = []
    const matching = (items: ReviewEvent[], since: string) =>
      items
        .filter((e) => e.updatedAt > since)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0))
    const poller = new ReviewNotificationPoller({
      getRepos: () => [
        {
          id: 'r1',
          displayName: 'proj',
          reviewNotifications: gitlabConfig({
            pollIntervalMinutes: 60,
            maxNotificationsPerHour: 1000
          })
        }
      ],
      getGlobalEnabled: () => true,
      store,
      delivery: { deliver: async () => {}, deliverDigest: async () => {} },
      now: () => nowRef.now,
      random: () => 0.5,
      gitlabList: async (_provider, cursors) => ({
        mrs: matching(openItems, cursors.mrSince),
        issues: matching(openIssues, cursors.issueSince)
      }),
      githubList: async () => ({ mrs: [], issues: [] }),
      gitlabListClosed: async (_provider, cursors) => ({
        mrs: matching(closedItems, cursors.mrSince),
        issues: matching(closedIssues, cursors.issueSince)
      }),
      githubListClosed: async () => ({ mrs: [], issues: [] }),
      setTimeoutFn: () => ({}),
      clearTimeoutFn: () => {}
    })
    poller.reconcile()
    return {
      poller,
      nowRef,
      setOpen: (items: ReviewEvent[]) => {
        openItems = items
      },
      setClosed: (items: ReviewEvent[]) => {
        closedItems = items
      },
      setOpenIssues: (items: ReviewEvent[]) => {
        openIssues = items
      },
      cursor: (kind: 'mr-open' | 'mr-closed' | 'issue-open' | 'issue-closed') =>
        store.getWatermark(watermarkKey('gitlab', 'gitlab.example.com', 'projects/42', kind))
    }
  }

  // Minutes after 2026-10-19T11:00:00Z.
  const at = (mins: number) =>
    new Date(new Date('2026-10-19T11:00:00Z').getTime() + mins * 60000).toISOString()
  const openMr = (iid: number, mins: number): ReviewEvent =>
    mrEvent({ iid, action: 'opened', updatedAt: at(mins), title: `MR ${iid}` })
  const closedMr = (iid: number, mins: number): ReviewEvent =>
    mrEvent({ iid, action: 'closed', updatedAt: at(mins), title: `MR ${iid}` })
  const openIssue = (iid: number, mins: number): ReviewEvent =>
    mrEvent({
      iid,
      kind: 'issue',
      action: 'opened',
      updatedAt: at(mins),
      title: `Issue ${iid}`,
      url: `https://gitlab.example.com/-/issues/${iid}`
    })

  it('resolves every closed item when the closed listing exceeds per_page', async () => {
    const h = pagedHarness()
    // Polls 1-2: 60 open MRs, all notified.
    h.setOpen(Array.from({ length: 60 }, (_, i) => openMr(i + 1, i + 1)))
    h.setClosed([])
    await h.poller.pollOnce('r1', 'gitlab')
    await h.poller.pollOnce('r1', 'gitlab')

    // Poll 3: all 60 now closed, plus a newer open MR. The source paginates
    // internally, so one poll sees every closed item and resolves all 60.
    h.nowRef.now = new Date('2026-10-19T12:10:00Z').getTime()
    h.setOpen([openMr(61, 91)])
    h.setClosed(Array.from({ length: 60 }, (_, i) => closedMr(i + 1, 60 + (i + 1) * 0.5)))
    const third = await h.poller.pollOnce('r1', 'gitlab')
    const resolved = third
      .filter((i) => i.disposition === 'resolve')
      .map((i) => i.event.iid)
      .sort((a, b) => a - b)
    expect(resolved).toEqual(Array.from({ length: 60 }, (_, i) => i + 1))
  })

  it('does not miss open items when a newer closed item exists', async () => {
    const h = pagedHarness()
    // Polls 1-2: 60 open MRs, all notified.
    h.setOpen(Array.from({ length: 60 }, (_, i) => openMr(i + 1, i + 1)))
    h.setClosed([])
    await h.poller.pollOnce('r1', 'gitlab')
    await h.poller.pollOnce('r1', 'gitlab')

    // Poll 3: 60 new open MRs plus one closed item newer than all of them.
    // Independent per-listing cursors keep the newer closed item from
    // advancing the open cursor past any MR.
    h.nowRef.now = new Date('2026-10-19T12:10:00Z').getTime()
    h.setOpen(Array.from({ length: 60 }, (_, i) => openMr(101 + i, 60 + (i + 1) * 0.5)))
    h.setClosed([closedMr(1, 91)])
    const third = await h.poller.pollOnce('r1', 'gitlab')
    const notified = third
      .filter((i) => i.disposition === 'notify')
      .map((i) => i.event.iid)
      .sort((a, b) => a - b)
    expect(notified).toEqual(Array.from({ length: 60 }, (_, i) => 101 + i))
    expect(third.filter((i) => i.disposition === 'resolve')).toHaveLength(1)
  })

  it('regression: a newer issue never advances the MR cursor past unfetched MRs', async () => {
    const h = pagedHarness()
    // Poll 1: two MRs plus one issue newer than both (each > 60s apart so the
    // overlap window cannot mask the cursor positions).
    h.setOpen([openMr(1, 0), openMr(2, 5)])
    h.setOpenIssues([openIssue(10, 10)])
    h.setClosed([])
    const first = await h.poller.pollOnce('r1', 'gitlab')
    expect(
      first
        .filter((i) => i.disposition === 'notify')
        .map((i) => i.event.iid)
        .sort((a, b) => a - b)
    ).toEqual([1, 2, 10])
    // Each cursor advances only from its own listing: the MR cursor must sit
    // at the newest MR (11:05), not at the newer issue (11:10).
    expect(h.cursor('mr-open')).toBe(at(5))
    expect(h.cursor('issue-open')).toBe(at(10))

    // Poll 2: a new MR updated between the MR cursor and the issue cursor. With
    // a shared cursor it would fall outside the MR query window and be missed.
    h.nowRef.now = new Date('2026-10-19T12:10:00Z').getTime()
    h.setOpen([openMr(3, 7)])
    h.setOpenIssues([])
    const second = await h.poller.pollOnce('r1', 'gitlab')
    const notified = second.filter((i) => i.disposition === 'notify').map((i) => i.event.iid)
    expect(notified).toEqual([3])
  })

  it('regression: a burst inside the skew window cannot pin the cursor', async () => {
    const h = pagedHarness()
    // 120 items, all updated within 60s of the initial cursor (11:00). The
    // source is fully paginated, so one poll sees all of them.
    const burst = Array.from({ length: 120 }, (_, i) =>
      openMr(i + 1, 10 / 60 + (i * 40) / 120 / 60)
    )
    h.setOpen(burst)
    h.setClosed([])
    const first = await h.poller.pollOnce('r1', 'gitlab')
    expect(first.filter((i) => i.disposition === 'notify')).toHaveLength(120)
    // The cursor must reach the newest item: with the skew baked into the
    // cursor, skewBack(max) <= previous pins it at 11:00 and every later poll
    // refetches the same set forever.
    const maxTs = burst
      .map((e) => e.updatedAt)
      .sort()
      .pop()
    expect(h.cursor('mr-open')).toBe(maxTs)

    // Poll 2: the overlap query refetches the tail, but fingerprints dedup it.
    // Nothing is newer than the cursor, so the cursor stays exactly where it
    // is instead of jumping to the local now (which could skip items updated
    // after the forge ran the query).
    const second = await h.poller.pollOnce('r1', 'gitlab')
    expect(second.filter((i) => i.disposition === 'notify')).toHaveLength(0)
    expect(h.cursor('mr-open')).toBe(maxTs)
  })
})

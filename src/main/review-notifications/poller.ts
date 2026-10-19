import type { Repo } from '../../shared/repo-types'
import {
  isReviewNotificationPollingEnabled,
  resolveReviewNotificationConfig,
  type ReviewNotificationConfig,
  type ReviewNotificationEventToggles
} from '../../shared/review-notification-types'
import { listGitLabClosedReviewItems, listGitLabReviewItems } from './gitlab-source'
import { listGitHubClosedReviewItems, listGitHubReviewItems } from './github-source'
import { advanceListingCursors, queryCursors, readListingCursors } from './listing-cursors'
import type { ReviewWatermarkStore } from './dedup'
import { classifyReviewItems } from './review-classify'
import { ReviewNotificationBudget, type ReviewBudgetDelivery } from './review-budget'
import type { ReviewEvent, ReviewPollItem } from './review-event'

export type ReviewPollerRepo = Pick<Repo, 'id' | 'displayName' | 'reviewNotifications'>

export type ReviewPollerDeps = {
  getRepos: () => ReviewPollerRepo[]
  getGlobalEnabled: () => boolean
  store: ReviewWatermarkStore
  delivery: ReviewBudgetDelivery
  now?: () => number
  random?: () => number
  onHealth?: (repoId: string, provider: 'gitlab' | 'github', error: string | null) => void
  gitlabList?: typeof listGitLabReviewItems
  githubList?: typeof listGitHubReviewItems
  gitlabListClosed?: typeof listGitLabClosedReviewItems
  githubListClosed?: typeof listGitHubClosedReviewItems
  setTimeoutFn?: (callback: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
}

export type ReviewPollSourceError = {
  kind: 'auth' | 'rate_limited' | 'network' | 'parse'
  retryAfterMs?: number
  message: string
}

function isSourceError(error: unknown): error is ReviewPollSourceError {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  return 'kind' in error && 'message' in error && typeof error.message === 'string'
}

type ProviderJob = {
  repoId: string
  repoLabel: string
  provider: 'gitlab' | 'github'
  config: ReviewNotificationConfig
  timer: unknown
  consecutiveFailures: number
  budget: ReviewNotificationBudget
}

const MAX_BACKOFF_MULTIPLIER = 4

export class ReviewNotificationPoller {
  private jobs = new Map<string, ProviderJob>()
  private stopped = false
  private deps: Required<
    Pick<
      ReviewPollerDeps,
      | 'now'
      | 'random'
      | 'gitlabList'
      | 'githubList'
      | 'gitlabListClosed'
      | 'githubListClosed'
      | 'setTimeoutFn'
      | 'clearTimeoutFn'
    >
  > &
    ReviewPollerDeps

  constructor(deps: ReviewPollerDeps) {
    this.deps = {
      now: () => Date.now(),
      random: Math.random,
      gitlabList: listGitLabReviewItems,
      githubList: listGitHubReviewItems,
      gitlabListClosed: listGitLabClosedReviewItems,
      githubListClosed: listGitHubClosedReviewItems,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
      ...deps
    }
  }

  start(): void {
    this.stopped = false
    this.reconcile()
  }

  stop(): void {
    this.stopped = true
    for (const job of this.jobs.values()) {
      if (job.timer) {
        this.deps.clearTimeoutFn(job.timer)
      }
      job.timer = null
    }
    this.jobs.clear()
  }

  /** Rebuild the job set from current repo configs (call on settings change). */
  reconcile(): void {
    const globalEnabled = this.deps.getGlobalEnabled()
    const seen = new Set<string>()
    for (const repo of this.deps.getRepos()) {
      const config = resolveReviewNotificationConfig(repo.reviewNotifications)
      if (!isReviewNotificationPollingEnabled(config, globalEnabled)) {
        continue
      }
      for (const provider of ['gitlab', 'github'] as const) {
        const providerConfig = config.providers[provider]
        if (!providerConfig?.enabled) {
          continue
        }
        const key = `${repo.id}|${provider}`
        seen.add(key)
        let job = this.jobs.get(key)
        if (!job) {
          job = {
            repoId: repo.id,
            repoLabel: repo.displayName || repo.id,
            provider,
            config,
            timer: null,
            consecutiveFailures: 0,
            budget: new ReviewNotificationBudget(this.deps.now)
          }
          this.jobs.set(key, job)
          this.schedule(job, this.jitteredInterval(job))
        } else {
          job.config = config
          job.repoLabel = repo.displayName || repo.id
        }
      }
    }
    for (const key of this.jobs.keys()) {
      if (!seen.has(key)) {
        const job = this.jobs.get(key)
        if (job?.timer) {
          this.deps.clearTimeoutFn(job.timer)
        }
        this.jobs.delete(key)
      }
    }
  }

  /** Single poll for one repo+provider; used by tests and manual refresh. */
  async pollOnce(repoId: string, provider: 'gitlab' | 'github'): Promise<ReviewPollItem[]> {
    const job = this.jobs.get(`${repoId}|${provider}`)
    if (!job) {
      return []
    }
    return this.pollJob(job)
  }

  private jitteredInterval(job: ProviderJob): number {
    const base = job.config.pollIntervalMinutes * 60 * 1000
    const jitter = 1 + (this.deps.random() * 0.4 - 0.2)
    return Math.max(60 * 1000, Math.round(base * jitter))
  }

  private schedule(job: ProviderJob, delayMs: number): void {
    if (this.stopped) {
      return
    }
    if (job.timer) {
      this.deps.clearTimeoutFn(job.timer)
    }
    job.timer = this.deps.setTimeoutFn(() => {
      void this.pollJob(job)
        .catch(() => {})
        .finally(() => {
          // Reschedule only while this exact job is still registered: a repo
          // disabled (or the kill-switch flipped) mid-poll must not leave an
          // orphan job polling with its stale config.
          if (this.isCurrentJob(job)) {
            this.schedule(job, this.nextDelay(job))
          }
        })
    }, delayMs)
  }

  /**
   * True while this exact job object is the registered job for its repo and
   * the poller is running. Guards every re-arm path against orphan reschedule.
   */
  private isCurrentJob(job: ProviderJob): boolean {
    return !this.stopped && this.jobs.get(`${job.repoId}|${job.provider}`) === job
  }

  private nextDelay(job: ProviderJob): number {
    const base = this.jitteredInterval(job)
    if (job.consecutiveFailures === 0) {
      return base
    }
    const multiplier = Math.min(2 ** job.consecutiveFailures, MAX_BACKOFF_MULTIPLIER)
    return base * multiplier
  }

  private hostOf(job: ProviderJob): string {
    if (job.provider === 'gitlab') {
      try {
        return new URL(job.config.providers.gitlab?.baseUrl ?? '').hostname
      } catch {
        return 'gitlab'
      }
    }
    return 'github.com'
  }

  private repoSlugOf(job: ProviderJob): string {
    if (job.provider === 'gitlab') {
      return `projects/${job.config.providers.gitlab?.projectId ?? 0}`
    }
    const gh = job.config.providers.github
    return `${gh?.owner ?? ''}/${gh?.repo ?? ''}`
  }

  private async pollJob(job: ProviderJob): Promise<ReviewPollItem[]> {
    // A job removed mid-flight (repo disabled, kill-switch flipped) must not
    // poll or deliver with its stale config.
    if (!this.isCurrentJob(job)) {
      return []
    }
    const host = this.hostOf(job)
    const slug = this.repoSlugOf(job)
    const pollWindowStart = new Date(
      this.deps.now() - job.config.pollIntervalMinutes * 60 * 1000
    ).toISOString()
    const since = readListingCursors(this.deps.store, job.provider, host, slug, pollWindowStart)
    const query = queryCursors(since)
    let listed: { mrs: ReviewEvent[]; issues: ReviewEvent[] }
    let closed: { mrs: ReviewEvent[]; issues: ReviewEvent[] }
    let events: ReviewNotificationEventToggles
    let watchedLabels: string[]
    try {
      if (job.provider === 'gitlab') {
        const provider = job.config.providers.gitlab
        if (!provider?.enabled) {
          return []
        }
        events = provider.events
        watchedLabels = provider.watchedLabels ?? []
        const [openItems, closedItems] = await Promise.all([
          this.deps.gitlabList(provider, query.open),
          this.deps.gitlabListClosed(provider, query.closed)
        ])
        listed = openItems
        closed = closedItems
      } else {
        const provider = job.config.providers.github
        if (!provider?.enabled) {
          return []
        }
        events = provider.events
        watchedLabels = provider.watchedLabels ?? []
        const [openItems, closedItems] = await Promise.all([
          this.deps.githubList(provider, query.open),
          this.deps.githubListClosed(provider, query.closed)
        ])
        listed = openItems
        closed = closedItems
      }
    } catch (error) {
      this.onSourceError(
        job,
        isSourceError(error) ? error : { kind: 'network', message: String(error) }
      )
      return []
    }
    job.consecutiveFailures = 0
    this.deps.onHealth?.(job.repoId, job.provider, null)

    const items = classifyReviewItems(
      { store: this.deps.store, now: this.deps.now },
      { provider: job.provider, events, watchedLabels, listed, closed }
    )
    const delivered = await job.budget.apply({
      repoLabel: job.repoLabel,
      items,
      maxPerHour: job.config.maxNotificationsPerHour,
      digest: job.config.digest,
      delivery: this.deps.delivery
    })

    advanceListingCursors(this.deps.store, job.provider, host, slug, since, listed, closed)
    await this.deps.store.flush()
    return delivered
  }

  private onSourceError(job: ProviderJob, error: ReviewPollSourceError): void {
    job.consecutiveFailures += 1
    // Never notify on poller failures; surface as a quiet health badge only.
    this.deps.onHealth?.(job.repoId, job.provider, error.message)
    if (error.kind === 'rate_limited' && error.retryAfterMs) {
      if (job.timer) {
        this.deps.clearTimeoutFn(job.timer)
      }
      job.timer = this.deps.setTimeoutFn(
        () => {
          // Same orphan guard as the normal re-arm path: a job removed while
          // waiting out the backoff must stay removed.
          if (this.isCurrentJob(job)) {
            this.schedule(job, this.nextDelay(job))
            void this.pollJob(job).catch(() => {})
          }
        },
        Math.min(error.retryAfterMs, 15 * 60 * 1000)
      )
    }
  }
}

/**
 * Phase 1a: inbound review-notification configuration (per repository).
 *
 * Notifies the user when a new merge request / pull request / issue appears on
 * a repository they care about, with an optional one-click summary. Everything
 * defaults to OFF: an absent or empty config means zero behavior change.
 *
 * Phase 1b (per-project agent trigger) and 1c (auto-approval) are separate and
 * not represented here beyond the `mode` field's future values.
 */

export type ReviewNotificationKind = 'mr' | 'issue'

export type ReviewNotificationAction =
  | 'opened'
  | 'reopened'
  | 'review_requested'
  | 'ready_for_review'
  | 'updated'
  | 'labeled'
  | 'merged'
  | 'closed'

/** Per-event-type toggles. All default to false except the two *_opened ones. */
export type ReviewNotificationEventToggles = {
  mrOpened: boolean
  mrUpdated: boolean
  mrMerged: boolean
  mrClosed: boolean
  issueOpened: boolean
  issueUpdated: boolean
}

export type GitLabReviewNotificationProvider = {
  kind: 'gitlab'
  enabled: boolean
  /**
   * e.g. "https://gitlab.example.com". Self-hosted instances are first-class.
   * Must be https unless `insecureHttp` is explicitly set (lab environments only).
   */
  baseUrl: string
  /** Numeric project ID (stable across renames, unlike the path). */
  projectId: number
  insecureHttp?: boolean
  /** Labels that trigger a notification on label events. Empty = none. */
  watchedLabels?: string[]
  events: ReviewNotificationEventToggles
}

export type GitHubReviewNotificationProvider = {
  kind: 'github'
  enabled: boolean
  owner: string
  repo: string
  /** Labels that trigger a notification on label events. Empty = none. */
  watchedLabels?: string[]
  events: ReviewNotificationEventToggles
}

export type ReviewNotificationMode = 'notify'

export type ReviewNotificationConfig = {
  enabled: boolean
  providers: {
    gitlab?: GitLabReviewNotificationProvider
    github?: GitHubReviewNotificationProvider
  }
  /** 1a only supports 'notify'. Agent triggering is phase 1b. */
  mode: ReviewNotificationMode
  /** Minutes between polls per repo+provider. */
  pollIntervalMinutes: number
  /** Group overflow into a digest notification instead of spamming. */
  digest: boolean
  maxNotificationsPerHour: number
}

export const DEFAULT_REVIEW_NOTIFICATION_EVENTS: ReviewNotificationEventToggles = {
  mrOpened: true,
  mrUpdated: false,
  mrMerged: false,
  mrClosed: false,
  issueOpened: true,
  issueUpdated: false
}

export const DEFAULT_REVIEW_POLL_INTERVAL_MINUTES = 10
export const DEFAULT_REVIEW_MAX_NOTIFICATIONS_PER_HOUR = 10

export function getDefaultReviewNotificationEvents(): ReviewNotificationEventToggles {
  return { ...DEFAULT_REVIEW_NOTIFICATION_EVENTS }
}

export function getDefaultReviewNotificationConfig(): ReviewNotificationConfig {
  return {
    enabled: false,
    providers: {},
    mode: 'notify',
    pollIntervalMinutes: DEFAULT_REVIEW_POLL_INTERVAL_MINUTES,
    digest: true,
    maxNotificationsPerHour: DEFAULT_REVIEW_MAX_NOTIFICATIONS_PER_HOUR
  }
}

function resolveEvents(
  partial?: Partial<ReviewNotificationEventToggles> | null
): ReviewNotificationEventToggles {
  return { ...getDefaultReviewNotificationEvents(), ...partial }
}

/**
 * Resolve a possibly-absent/partial config to a full one.
 * Absent config resolves to all-off: the poller treats the repo as disabled.
 */
export function resolveReviewNotificationConfig(
  partial?: Partial<ReviewNotificationConfig> | null
): ReviewNotificationConfig {
  const defaults = getDefaultReviewNotificationConfig()
  if (!partial) {
    return defaults
  }
  return {
    ...defaults,
    ...partial,
    providers: {
      ...(partial.providers?.gitlab ? { gitlab: { ...partial.providers.gitlab } } : {}),
      ...(partial.providers?.github ? { github: { ...partial.providers.github } } : {})
    },
    mode: 'notify'
  }
}

/** Normalize event toggles possibly stored without newer fields. */
export function resolveReviewNotificationEvents(
  partial?: Partial<ReviewNotificationEventToggles> | null
): ReviewNotificationEventToggles {
  return resolveEvents(partial)
}

function isValidGitLabProvider(p: GitLabReviewNotificationProvider): boolean {
  return p.enabled && Number.isFinite(p.projectId) && p.projectId > 0 && p.baseUrl.trim().length > 0
}

function isValidGitHubProvider(p: GitHubReviewNotificationProvider): boolean {
  return p.enabled && p.owner.trim().length > 0 && p.repo.trim().length > 0
}

/**
 * True when the poller should run for this repo: master switch on, global
 * kill-switch on, and at least one valid enabled provider.
 */
export function isReviewNotificationPollingEnabled(
  config: ReviewNotificationConfig | undefined | null,
  globalEnabled: boolean
): boolean {
  if (!globalEnabled || !config?.enabled) {
    return false
  }
  const { gitlab, github } = config.providers
  return (
    (gitlab !== undefined && isValidGitLabProvider(gitlab)) ||
    (github !== undefined && isValidGitHubProvider(github))
  )
}

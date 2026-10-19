import type React from 'react'
import type { Repo } from '../../../../shared/repo-types'
import {
  getDefaultReviewNotificationEvents,
  resolveReviewNotificationConfig,
  type GitHubReviewNotificationProvider,
  type GitLabReviewNotificationProvider,
  type ReviewNotificationConfig,
  type ReviewNotificationEventToggles
} from '../../../../shared/review-notification-types'
import { useAppStore } from '../../store'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { translate } from '@/i18n/i18n'

type ReviewNotificationsSectionProps = {
  repo: Repo
  updateRepo: (
    repoId: string,
    updates: { reviewNotifications?: ReviewNotificationConfig }
  ) => void | Promise<boolean>
}

function tr(key: string, fallback: string): string {
  return translate(`auto.components.settings.ReviewNotificationsSection.${key}`, fallback)
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
  disabled
}: {
  id: string
  label: string
  description?: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  type,
  disabled
}: {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  type?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        type={type ?? 'text'}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 text-sm"
      />
    </div>
  )
}

const EVENT_ROWS: {
  key: keyof ReviewNotificationEventToggles
  labelKey: string
  fallback: string
}[] = [
  { key: 'mrOpened', labelKey: 'event.mrOpened', fallback: 'New merge request / pull request' },
  {
    key: 'mrUpdated',
    labelKey: 'event.mrUpdated',
    fallback: 'Merge request / pull request updated'
  },
  { key: 'mrMerged', labelKey: 'event.mrMerged', fallback: 'Merge request / pull request merged' },
  { key: 'mrClosed', labelKey: 'event.mrClosed', fallback: 'Merge request / pull request closed' },
  { key: 'issueOpened', labelKey: 'event.issueOpened', fallback: 'New issue' },
  { key: 'issueUpdated', labelKey: 'event.issueUpdated', fallback: 'Issue updated' }
]

export function ReviewNotificationsSection({
  repo,
  updateRepo
}: ReviewNotificationsSectionProps): React.JSX.Element {
  const globalEnabled = useAppStore((s) => s.settings?.reviewNotificationsEnabled !== false)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const config = resolveReviewNotificationConfig(repo.reviewNotifications)

  const save = (next: ReviewNotificationConfig) => {
    void updateRepo(repo.id, { reviewNotifications: next })
  }
  const patch = (p: Partial<ReviewNotificationConfig>) => save({ ...config, ...p })

  // Numeric fields: ignore empty/invalid keystrokes so the field can be
  // cleared and retyped. The controlled input snaps back to the saved value
  // until a valid number is entered.
  const setPositiveInt = (next: string, apply: (value: number) => void) => {
    if (next.trim() === '') {
      return
    }
    const n = Number(next)
    if (Number.isFinite(n)) {
      apply(Math.max(1, Math.floor(n)))
    }
  }

  const gitlab: GitLabReviewNotificationProvider = {
    kind: 'gitlab',
    enabled: false,
    baseUrl: 'https://gitlab.com',
    projectId: 0,
    ...config.providers.gitlab,
    events: { ...getDefaultReviewNotificationEvents(), ...config.providers.gitlab?.events }
  }
  const github: GitHubReviewNotificationProvider = {
    kind: 'github',
    enabled: false,
    owner: '',
    repo: '',
    ...config.providers.github,
    events: { ...getDefaultReviewNotificationEvents(), ...config.providers.github?.events }
  }

  const setGitlab = (p: Partial<GitLabReviewNotificationProvider>) =>
    patch({ providers: { ...config.providers, gitlab: { ...gitlab, ...p } } })
  const setGithub = (p: Partial<GitHubReviewNotificationProvider>) =>
    patch({ providers: { ...config.providers, github: { ...github, ...p } } })

  const renderEvents = (
    events: ReviewNotificationEventToggles,
    onChange: (next: ReviewNotificationEventToggles) => void,
    prefix: string,
    disabled: boolean
  ) => (
    <div className="space-y-0.5 rounded-md border border-border p-3">
      {EVENT_ROWS.map((row) => (
        <ToggleRow
          key={`${prefix}-${row.key}`}
          id={`${prefix}-${row.key}-${repo.id}`}
          label={tr(row.labelKey, row.fallback)}
          checked={events[row.key]}
          disabled={disabled}
          onChange={(next) => onChange({ ...events, [row.key]: next })}
        />
      ))}
    </div>
  )

  return (
    <section className="space-y-4">
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-semibold">{tr('title', 'Review notifications')}</h3>
        <p className="text-xs text-muted-foreground">
          {tr(
            'description',
            'Get notified when new merge requests, pull requests, or issues appear on this project. Polling only — nothing is sent to the forge. All off by default.'
          )}
        </p>
      </div>

      <ToggleRow
        id={`review-notifications-global-${repo.id}`}
        label={tr('globalKillSwitch', 'Enable review notifications (global)')}
        description={tr(
          'globalKillSwitchDescription',
          'Master switch for all projects. Turn off to stop every review-notification poll.'
        )}
        checked={globalEnabled}
        onChange={(next) => void updateSettings({ reviewNotificationsEnabled: next })}
      />

      <ToggleRow
        id={`review-notifications-enabled-${repo.id}`}
        label={tr('enabled', 'Notify me about this project')}
        checked={config.enabled}
        disabled={!globalEnabled}
        onChange={(next) => patch({ enabled: next })}
      />

      {config.enabled && globalEnabled ? (
        <div className="space-y-6">
          <div className="space-y-3">
            <ToggleRow
              id={`review-notifications-gitlab-enabled-${repo.id}`}
              label={tr('gitlabEnabled', 'GitLab')}
              description={tr(
                'gitlabDescription',
                'Poll a GitLab project (gitlab.com or self-hosted) for merge requests and issues.'
              )}
              checked={gitlab.enabled}
              onChange={(next) => setGitlab({ enabled: next })}
            />
            {gitlab.enabled ? (
              <div className="space-y-3 pl-1">
                <Field
                  id={`review-notifications-gitlab-baseurl-${repo.id}`}
                  label={tr('gitlabBaseUrl', 'GitLab base URL')}
                  value={gitlab.baseUrl}
                  placeholder="https://gitlab.example.com"
                  onChange={(next) => setGitlab({ baseUrl: next })}
                />
                <Field
                  id={`review-notifications-gitlab-projectid-${repo.id}`}
                  label={tr('gitlabProjectId', 'Project ID (numeric)')}
                  value={gitlab.projectId ? String(gitlab.projectId) : ''}
                  type="number"
                  placeholder="123456"
                  onChange={(next) => setPositiveInt(next, (n) => setGitlab({ projectId: n }))}
                />
                <Field
                  id={`review-notifications-gitlab-labels-${repo.id}`}
                  label={tr('watchedLabels', 'Watched labels (comma-separated, optional)')}
                  value={(gitlab.watchedLabels ?? []).join(', ')}
                  placeholder="urgent, review-needed"
                  onChange={(next) =>
                    setGitlab({
                      watchedLabels: next
                        .split(',')
                        .map((l) => l.trim())
                        .filter(Boolean)
                    })
                  }
                />
                {renderEvents(gitlab.events, (events) => setGitlab({ events }), 'gitlab', false)}
              </div>
            ) : null}
          </div>

          <div className="space-y-3">
            <ToggleRow
              id={`review-notifications-github-enabled-${repo.id}`}
              label={tr('githubEnabled', 'GitHub')}
              description={tr(
                'githubDescription',
                'Poll a GitHub repository for pull requests and issues.'
              )}
              checked={github.enabled}
              onChange={(next) => setGithub({ enabled: next })}
            />
            {github.enabled ? (
              <div className="space-y-3 pl-1">
                <Field
                  id={`review-notifications-github-owner-${repo.id}`}
                  label={tr('githubOwner', 'Owner')}
                  value={github.owner}
                  placeholder="octocat"
                  onChange={(next) => setGithub({ owner: next })}
                />
                <Field
                  id={`review-notifications-github-repo-${repo.id}`}
                  label={tr('githubRepo', 'Repository')}
                  value={github.repo}
                  placeholder="hello-world"
                  onChange={(next) => setGithub({ repo: next })}
                />
                <Field
                  id={`review-notifications-github-labels-${repo.id}`}
                  label={tr('watchedLabels', 'Watched labels (comma-separated, optional)')}
                  value={(github.watchedLabels ?? []).join(', ')}
                  placeholder="urgent, review-needed"
                  onChange={(next) =>
                    setGithub({
                      watchedLabels: next
                        .split(',')
                        .map((l) => l.trim())
                        .filter(Boolean)
                    })
                  }
                />
                {renderEvents(github.events, (events) => setGithub({ events }), 'github', false)}
              </div>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field
              id={`review-notifications-interval-${repo.id}`}
              label={tr('pollInterval', 'Poll interval (minutes)')}
              value={String(config.pollIntervalMinutes)}
              type="number"
              onChange={(next) => setPositiveInt(next, (n) => patch({ pollIntervalMinutes: n }))}
            />
            <Field
              id={`review-notifications-maxhour-${repo.id}`}
              label={tr('maxPerHour', 'Max notifications per hour')}
              value={String(config.maxNotificationsPerHour)}
              type="number"
              onChange={(next) =>
                setPositiveInt(next, (n) => patch({ maxNotificationsPerHour: n }))
              }
            />
          </div>
          <ToggleRow
            id={`review-notifications-digest-${repo.id}`}
            label={tr('digest', 'Group overflow into a digest')}
            description={tr(
              'digestDescription',
              'When more items arrive than the hourly limit, bundle the extras into one digest notification instead of dropping them.'
            )}
            checked={config.digest}
            onChange={(next) => patch({ digest: next })}
          />
        </div>
      ) : null}
    </section>
  )
}

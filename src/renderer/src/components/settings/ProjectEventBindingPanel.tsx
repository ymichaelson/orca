import { useState } from 'react'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { translate } from '@/i18n/i18n'
import { useNow } from '@/hooks/use-now'
import type {
  ProjectEventActivityEntry,
  ProjectEventActivityView
} from '../../../../shared/forge-inbox-project-event-activity'
import type { ProjectEventBindingView } from '../../../../shared/forge-inbox-project-binding'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { forgeErrorCodeLabel } from '../forge-inbox/forge-inbox-error-code-copy'
import { UnsealedCredentialNotice } from './UnsealedCredentialNotice'
import { useProjectEventBindingActions } from './use-project-event-binding-actions'
import {
  activityKindCopy,
  activityOutcomeCopy,
  bindingFailureCopy,
  bindingFailurePhaseCopy,
  bindingStateCopy,
  secretProtectionCopy
} from './project-event-status-copy'

const DASH = '—'

function ActivityLine({
  entry,
  now
}: {
  entry: ProjectEventActivityEntry
  now: number
}): React.JSX.Element {
  return (
    <li className="text-xs leading-relaxed">
      <span className="font-medium">{activityKindCopy(entry.kind)}</span>{' '}
      <span className="text-muted-foreground">{entry.iid === null ? DASH : entry.iid}</span>
      {entry.title ? <span> {entry.title}</span> : null}{' '}
      <span className="text-muted-foreground">{activityOutcomeCopy(entry.outcome)}</span>{' '}
      <span className="text-muted-foreground">{formatUiRelativeTime(entry.occurredAt - now)}</span>
      {entry.errorCode ? (
        <span className="text-destructive">
          {' '}
          {forgeErrorCodeLabel(entry.errorCode, entry.errorSource)}
        </span>
      ) : null}
    </li>
  )
}

function lastProcessedCopy(entry: ProjectEventActivityEntry, now: number): string {
  const subject = `${activityKindCopy(entry.kind)} ${entry.iid ?? DASH}`
  // Why: an older host omits finishedAt, and its occurredAt is the receipt time, not completion.
  if (entry.finishedAt === undefined) {
    return translate(
      'projectEventAgent.activity.lastProcessedReceived',
      '{{subject}} · received {{time}}',
      { subject, time: formatUiRelativeTime(entry.occurredAt - now) }
    )
  }
  return `${subject} · ${formatUiRelativeTime(entry.finishedAt - now)}`
}

function ActivityBlock({
  activity
}: {
  activity: ProjectEventActivityView | null
}): React.JSX.Element | null {
  const now = useNow(30_000, activity !== null)
  if (activity === null) {
    return null
  }
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">
        {translate('projectEventAgent.activity.title', 'Recent events')}
      </p>
      {activity.events.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate('projectEventAgent.activity.empty', 'No events received yet.')}
        </p>
      ) : (
        <ul className="space-y-1">
          {activity.events.map((entry) => (
            <ActivityLine key={entry.id} entry={entry} now={now} />
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {translate('projectEventAgent.activity.lastProcessedLabel', 'Last delivery that finished:')}{' '}
        {activity.lastProcessed === null
          ? translate('projectEventAgent.activity.lastProcessedNone', 'none yet')
          : lastProcessedCopy(activity.lastProcessed, now)}
      </p>
    </div>
  )
}

function BindingSummary({ binding }: { binding: ProjectEventBindingView }): React.JSX.Element {
  return (
    <>
      <p className="text-sm font-medium">{bindingStateCopy(binding.state)}</p>
      {binding.failure ? (
        <p className="text-xs text-destructive">
          {translate('projectEventAgent.binding.failedDuring', 'Failed {{phase}}: {{reason}}', {
            phase: bindingFailurePhaseCopy(binding.failure.phase),
            reason: bindingFailureCopy(binding.failure.code)
          })}
        </p>
      ) : null}
      {binding.failure?.retryable === false ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'projectEventAgent.binding.notRetryable',
            'Retrying will usually not help; fix the configuration first.'
          )}
        </p>
      ) : null}
      {binding.rejectedEvents.length > 0 ? (
        <div className="text-xs text-destructive">
          <p>
            {translate(
              'projectEventAgent.binding.rejectedEvents',
              'GitLab refused these event types:'
            )}
          </p>
          <ul className="list-disc pl-4">
            {binding.rejectedEvents.map((event) => (
              <li key={event}>{event}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {binding.rotationPending ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'projectEventAgent.rotate.pending',
            'A new secret is staged; GitLab has not confirmed it yet, so the current secret is still in use.'
          )}
        </p>
      ) : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">
          {translate('projectEventAgent.binding.gitlabProject', 'GitLab project')}
        </dt>
        <dd className="break-all">{`${binding.gitlabHost}/${binding.gitlabPath}`}</dd>
        <dt className="text-muted-foreground">
          {translate('projectEventAgent.binding.projectId', 'Project ID')}
        </dt>
        <dd>{binding.gitlabProjectId}</dd>
        {binding.hookId === null ? null : (
          <>
            <dt className="text-muted-foreground">
              {translate('projectEventAgent.binding.hookId', 'Hook ID')}
            </dt>
            <dd>{binding.hookId}</dd>
          </>
        )}
        <dt className="text-muted-foreground">
          {translate('projectEventAgent.binding.callbackUrl', 'Callback URL')}
        </dt>
        <dd className="break-all">{binding.callbackUrl}</dd>
      </dl>
      {binding.secretProtection === 'plaintext' ? (
        <UnsealedCredentialNotice
          protection={binding.secretProtection}
          credentialName={translate('projectEventAgent.secretName', 'The webhook secret')}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          {secretProtectionCopy(binding.secretProtection)}
        </p>
      )}
    </>
  )
}

/** Connection facts and the two host-side actions; it never polls and never shows the secret. */
export function ProjectEventBindingPanel({
  ownerHostId,
  repoId,
  target,
  binding,
  activity,
  saving,
  refreshStatus
}: {
  ownerHostId: string | null
  repoId: string
  target: RuntimeClientTarget
  binding: ProjectEventBindingView | null
  activity: ProjectEventActivityView | null
  saving: boolean
  refreshStatus: () => Promise<void>
}): React.JSX.Element {
  const actions = useProjectEventBindingActions({
    ownerHostId,
    repoId,
    target,
    disabled: saving,
    onCompleted: refreshStatus
  })
  const [rotateOpen, setRotateOpen] = useState(false)
  const [allowUnprotected, setAllowUnprotected] = useState(false)
  const locked = saving || actions.busy !== null
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <p className="text-sm font-semibold">
        {translate('projectEventAgent.connection.title', 'Webhook connection')}
      </p>
      {binding === null ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'projectEventAgent.binding.none',
            'No callback is registered for this project yet.'
          )}
        </p>
      ) : (
        <BindingSummary binding={binding} />
      )}
      <ActivityBlock activity={activity} />
      {ownerHostId === null ? null : (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() => void actions.retry()}
          >
            {actions.busy === 'retry'
              ? translate('projectEventAgent.retry.busy', 'Re-checking…')
              : translate('projectEventAgent.retry.action', 'Re-check connection')}
          </Button>
          {binding === null ? null : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => setRotateOpen(true)}
            >
              {translate('projectEventAgent.rotate.action', 'Rotate secret')}
            </Button>
          )}
        </div>
      )}
      {actions.notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {actions.notice}
        </p>
      ) : null}
      {actions.error ? (
        <p role="alert" className="text-xs text-destructive">
          {actions.error}
        </p>
      ) : null}
      {actions.offersUnprotected ? (
        <div
          role="group"
          aria-label={translate(
            'projectEventAgent.rotate.unprotectedTitle',
            'Unencrypted storage consent'
          )}
          className="space-y-2 rounded-md border border-status-warning-border bg-status-warning-background p-2"
        >
          <p className="text-xs text-status-warning">
            {translate(
              'projectEventAgent.rotate.unprotectedBody',
              'This host has no keyring it can use, so the new secret would be stored unencrypted. Only continue if that is acceptable on this machine.'
            )}
          </p>
          <label className="flex items-start gap-2 text-xs">
            <Checkbox
              checked={allowUnprotected}
              onCheckedChange={(value) => setAllowUnprotected(value === true)}
            />
            <span>
              {translate(
                'projectEventAgent.rotate.unprotectedConsent',
                'I accept that the secret is stored unencrypted on this host.'
              )}
            </span>
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!allowUnprotected || actions.busy !== null}
            onClick={() => void actions.rotate(true)}
          >
            {translate(
              'projectEventAgent.rotate.unprotectedAction',
              'Rotate with unencrypted storage'
            )}
          </Button>
        </div>
      ) : null}
      <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <DialogContent surface="security" size="compact">
          <DialogHeader>
            <DialogTitle size="compact">
              {translate('projectEventAgent.rotate.confirmTitle', 'Rotate webhook secret?')}
            </DialogTitle>
            <DialogDescription size="compact">
              {translate(
                'projectEventAgent.rotate.confirmBody',
                'Rotating replaces the callback secret. GitLab switches to the new secret as soon as it accepts it.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" size="sm" variant="outline" onClick={() => setRotateOpen(false)}>
              {translate('projectEventAgent.rotate.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setRotateOpen(false)
                void actions.rotate()
              }}
            >
              {translate('projectEventAgent.rotate.confirmAction', 'Rotate now')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

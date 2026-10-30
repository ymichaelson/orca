import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { ForgeInboxStatus } from '../../../../shared/forge-inbox-rpc-types'
import { receiverListenerErrorText } from '../settings/project-event-receiver-error-text'
import { forgePhaseLabel } from './forge-inbox-display'

function listenerSummary(status: Extract<ForgeInboxStatus, { ownerHostId: string }>): string {
  if (status.listener.error !== null) {
    return translate(
      'auto.components.forge-inbox.ForgeInboxStatusStrip.listenerError',
      'Listener error: {{error}}',
      { error: receiverListenerErrorText(status.listener.error) }
    )
  }
  if (!status.listener.enabled) {
    return translate(
      'auto.components.forge-inbox.ForgeInboxStatusStrip.listenerOff',
      'Listener off'
    )
  }
  if (status.listener.listening && status.listener.port !== null) {
    return translate(
      'auto.components.forge-inbox.ForgeInboxStatusStrip.listeningOn',
      'Listening on port {{port}}',
      { port: status.listener.port }
    )
  }
  return translate(
    'auto.components.forge-inbox.ForgeInboxStatusStrip.listenerStarting',
    'Listener not bound'
  )
}

/** Honest, always-visible host state: a stopped listener or credential failure is never hidden. */
export function ForgeInboxStatusStrip({
  status,
  error,
  loading,
  onRetry,
  onOpenReceiverSettings
}: {
  status: ForgeInboxStatus | null
  error: string | null
  loading: boolean
  onRetry: () => void
  onOpenReceiverSettings?: () => void
}): React.JSX.Element {
  if (error !== null) {
    return (
      <div className="flex items-center gap-3 border-b border-border px-3 py-2 md:px-5">
        <p className="flex-1 text-xs text-destructive">
          {translate(
            'auto.components.forge-inbox.ForgeInboxStatusStrip.statusFailedGeneric',
            'Could not read the inbox status from this host.'
          )}
        </p>
        <Button size="xs" variant="outline" onClick={onRetry}>
          {translate('auto.components.forge-inbox.ForgeInboxStatusStrip.retry', 'Retry')}
        </Button>
      </div>
    )
  }
  if (loading && status === null) {
    return (
      <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground md:px-5">
        {translate(
          'auto.components.forge-inbox.ForgeInboxStatusStrip.checking',
          'Checking the inbox on this host…'
        )}
      </div>
    )
  }
  if (status === null || status.phase === 'unattached') {
    return (
      <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground md:px-5">
        {translate(
          'auto.components.forge-inbox.ForgeInboxStatusStrip.unavailable',
          'This host does not run the agent inbox. Webhooks cannot be received here.'
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-xs text-muted-foreground md:px-5">
      <Badge variant={status.available ? 'secondary' : 'outline'}>
        {forgePhaseLabel(status.phase)}
      </Badge>
      <span>{listenerSummary(status)}</span>
      {status.listener.error !== null && onOpenReceiverSettings !== undefined ? (
        <Button size="xs" variant="outline" onClick={onOpenReceiverSettings}>
          {translate('webhook.settings.openShort', 'Open webhook settings')}
        </Button>
      ) : null}
      <span>
        {translate(
          'auto.components.forge-inbox.ForgeInboxStatusStrip.queue',
          '{{pending}} queued · {{needsAuth}} need credentials',
          { pending: status.work.pending, needsAuth: status.work.needsAuth }
        )}
      </span>
      {status.dormant ? (
        <span>
          {translate(
            'auto.components.forge-inbox.ForgeInboxStatusStrip.dormant',
            'No inbox database yet'
          )}
        </span>
      ) : null}
      <span className="ml-auto font-mono text-2xs">
        {translate('auto.components.forge-inbox.ForgeInboxStatusStrip.owner', 'Host {{hostId}}', {
          hostId: status.ownerHostId
        })}
      </span>
    </div>
  )
}

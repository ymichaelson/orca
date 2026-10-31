import { useEffect, useRef } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useNow } from '@/hooks/use-now'
import { translate } from '@/i18n/i18n'
import type { ForgeInboxStatus } from '../../../../shared/forge-inbox-rpc-types'
import type { ForgeInboxActiveRunView } from '../../../../shared/forge-inbox-types'
import { receiverListenerErrorText } from '../settings/project-event-receiver-error-text'
import { useNativeChatElapsedSeconds } from '../native-chat/use-native-chat-elapsed-seconds'
import { formatNativeChatThreadGoalElapsed } from '../native-chat/native-chat-thread-goal-presentation'
import { forgePhaseLabel } from './forge-inbox-display'

/** Re-reads the host's own status while the page is open, so an active run is seen as it starts. */
const STATUS_REFRESH_MS = 5_000

function ActiveRunChip({
  run,
  onSelect
}: {
  run: ForgeInboxActiveRunView
  onSelect?: ((itemId: number) => void) | undefined
}): React.JSX.Element {
  const elapsed = useNativeChatElapsedSeconds(run.since, true)
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="max-w-72"
      onClick={onSelect === undefined ? undefined : () => onSelect(run.itemId)}
      disabled={onSelect === undefined}
    >
      <LoaderCircle className="size-3 animate-spin" />
      <span className="truncate">{run.itemTitle}</span>
      <span className="shrink-0 font-mono text-2xs text-muted-foreground">
        {formatNativeChatThreadGoalElapsed(elapsed)}
      </span>
    </Button>
  )
}

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
  onOpenReceiverSettings,
  onRefreshStatus,
  onSelectActiveRun
}: {
  status: ForgeInboxStatus | null
  error: string | null
  loading: boolean
  onRetry: () => void
  onOpenReceiverSettings?: () => void
  /** A background re-read; without it the strip keeps whatever the page loaded once. */
  onRefreshStatus?: (() => void) | undefined
  onSelectActiveRun?: ((itemId: number) => void) | undefined
}): React.JSX.Element {
  const tick = useNow(STATUS_REFRESH_MS, onRefreshStatus !== undefined)
  const lastTick = useRef(tick)
  useEffect(() => {
    if (tick === lastTick.current) {
      return
    }
    lastTick.current = tick
    onRefreshStatus?.()
  }, [tick, onRefreshStatus])

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
      {(status.activeRuns ?? []).length > 0 ? (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
          {(status.activeRuns ?? []).map((run) => (
            <ActiveRunChip key={run.runId} run={run} onSelect={onSelectActiveRun} />
          ))}
        </span>
      ) : null}
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

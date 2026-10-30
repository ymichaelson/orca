import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { openStructuredSessionById } from '@/lib/open-structured-session-by-id'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { ForgeRunView } from '../../../../shared/forge-inbox-rpc-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  forgeRunReasonLabel,
  forgeRunStateLabel,
  forgeRunStateVariant,
  formatForgeDateTime
} from './forge-inbox-display'
import { forgeDispatchConfirmationDisplay } from './forge-inbox-dispatch-confirmation-display'
import {
  forgeDispatchSnapshotLines,
  forgeTerminalExitLines
} from './forge-inbox-dispatch-facts-display'
import { ForgeInboxError, type ForgeInboxRepairActions } from './ForgeInboxError'

/** Execution detail stays with the run, so the timeline only points at it by id. */
export function ForgeInboxRunCard({
  run,
  ownerTarget,
  repairActions
}: {
  run: ForgeRunView
  ownerTarget: RuntimeClientTarget
  repairActions?: ForgeInboxRepairActions
}): React.JSX.Element {
  const confirmation = forgeDispatchConfirmationDisplay(run)
  const terminalOpen =
    run.state === 'unverifiable' &&
    run.errorCode === 'terminal-handoff' &&
    run.terminalExit === undefined
  const originalSessionId = run.reason === 'project-event-dispatch' ? run.sessionId : null
  const facts = [
    ...(run.dispatchSnapshot ? forgeDispatchSnapshotLines(run.dispatchSnapshot) : []),
    ...(run.terminalExit ? forgeTerminalExitLines(run.terminalExit) : [])
  ]
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={forgeRunStateVariant(run.state)}>
          {forgeRunStateLabel(run.state, run.cancellation, terminalOpen)}
        </Badge>
        {confirmation !== null ? (
          <Badge variant={confirmation.variant}>{confirmation.label}</Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {translate(
            'auto.components.forge-inbox.ForgeInboxDetail.revision',
            'revision {{revision}}',
            { revision: run.revision }
          )}
        </span>
        <span className="text-2xs text-muted-foreground">{formatForgeDateTime(run.updatedAt)}</span>
        {run.reason !== null ? (
          <span className="text-2xs text-muted-foreground">{forgeRunReasonLabel(run.reason)}</span>
        ) : null}
        {run.errorCode !== null ? (
          <ForgeInboxError code={run.errorCode} repairActions={repairActions} />
        ) : null}
      </div>
      {originalSessionId !== null ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="mt-2"
          onClick={() =>
            // Why: the chat opens in a worktree tab, which an Inbox page still covers.
            void openStructuredSessionById(originalSessionId, ownerTarget).then((opened) => {
              if (opened) {
                useAppStore.getState().closeInboxPage()
              }
            })
          }
        >
          {translate(
            'auto.components.forge-inbox.display.openOriginalSession',
            'Open original session'
          )}
        </Button>
      ) : null}
      {facts.length > 0 ? (
        <ul className="mt-2 list-none text-xs leading-5 text-muted-foreground">
          {facts.map((line, index) => (
            <li key={`${run.id}:fact:${index}`}>{line}</li>
          ))}
        </ul>
      ) : null}
      {confirmation !== null &&
      (confirmation.lines.length > 0 || confirmation.explanation !== null) ? (
        <div className="mt-2 flex flex-col gap-1 text-xs leading-5 text-muted-foreground">
          {confirmation.explanation !== null ? <p>{confirmation.explanation}</p> : null}
          {confirmation.lines.length > 0 ? (
            <ul className="list-disc pl-4">
              {confirmation.lines.map((line, index) => (
                <li key={`${run.id}:${index}`}>{line}</li>
              ))}
            </ul>
          ) : null}
          {confirmation.stateOnly ? (
            <p>
              {translate(
                'auto.components.forge-inbox.display.dispatchStateOnly',
                'GitLab shows this state but not who caused it.'
              )}
            </p>
          ) : null}
        </div>
      ) : null}
      {run.result !== null ? (
        <div className="mt-2 flex flex-col gap-1">
          <p className="whitespace-pre-wrap text-xs leading-5 text-foreground/85">
            {run.result.summary}
          </p>
          {run.result.concerns.length > 0 ? (
            <ul className="list-disc pl-4 text-xs leading-5 text-muted-foreground">
              {run.result.concerns.map((concern) => (
                <li key={`${run.id}:${concern}`} className="whitespace-pre-wrap">
                  {concern}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

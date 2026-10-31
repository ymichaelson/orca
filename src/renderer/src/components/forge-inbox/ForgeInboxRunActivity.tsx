import { useMemo } from 'react'
import { FilePenLine, LoaderCircle, MessageSquare, Wrench } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useStructuredAgentSessionRead } from '../native-chat/use-structured-agent-session-read'
import {
  forgeRunActivitySteps,
  type ForgeRunActivityStep,
  type ForgeRunActivityStepKind
} from './forge-inbox-run-activity-steps'

const VISIBLE_STEPS = 6

const STEP_ICON: Record<ForgeRunActivityStepKind, typeof Wrench> = {
  tool: Wrench,
  message: MessageSquare,
  edit: FilePenLine
}

function StepRow({ step }: { step: ForgeRunActivityStep }): React.JSX.Element {
  const Icon = STEP_ICON[step.kind]
  return (
    <li className="flex min-w-0 items-baseline gap-2 text-xs leading-5">
      <Icon className="size-3 shrink-0 self-center text-muted-foreground" />
      <span className="w-24 shrink-0 truncate font-mono text-2xs text-muted-foreground">
        {step.label}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground/85" title={step.detail}>
        {step.detail}
      </span>
      {step.state === 'running' ? (
        <span className="shrink-0 text-2xs text-muted-foreground">
          {translate('auto.components.forge-inbox.ForgeInboxRunActivity.stepRunning', 'running')}
        </span>
      ) : null}
      {step.state === 'failed' ? (
        <span className="shrink-0 text-2xs text-destructive">
          {translate('auto.components.forge-inbox.ForgeInboxRunActivity.stepFailed', 'failed')}
        </span>
      ) : null}
    </li>
  )
}

/**
 * What the dispatched agent is doing, read live from its own session journal. It only reads: the
 * reader never keeps the agent alive, and opening the Inbox is not the same as reading the chat.
 */
export function ForgeInboxRunActivity({
  sessionId,
  target
}: {
  sessionId: string
  target: RuntimeClientTarget
}): React.JSX.Element | null {
  const { state } = useStructuredAgentSessionRead({ sessionId, target, isViewed: false })
  const steps = useMemo(() => forgeRunActivitySteps(state.items, VISIBLE_STEPS), [state.items])
  const loading = state.status === 'loading' && steps.length === 0
  if (steps.length === 0 && !loading) {
    return null
  }
  const working = state.working === true
  return (
    <div className="mt-2 flex flex-col gap-1 border-t border-border/60 pt-2">
      <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {working ? <LoaderCircle className="size-3 animate-spin" /> : null}
        <span>
          {translate('auto.components.forge-inbox.ForgeInboxRunActivity.title', 'Activity')}
        </span>
        <span className="font-normal normal-case tracking-normal">
          {loading
            ? translate(
                'auto.components.forge-inbox.ForgeInboxRunActivity.loading',
                'reading the steps…'
              )
            : working
              ? translate(
                  'auto.components.forge-inbox.ForgeInboxRunActivity.working',
                  'working now'
                )
              : translate(
                  'auto.components.forge-inbox.ForgeInboxRunActivity.latest',
                  'latest steps'
                )}
        </span>
      </div>
      <ul className="flex flex-col">
        {steps.map((step) => (
          <StepRow key={step.id} step={step} />
        ))}
      </ul>
    </div>
  )
}

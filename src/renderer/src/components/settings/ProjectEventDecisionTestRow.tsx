import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import type { ProjectEventDecisionProbeResult } from '../../../../shared/project-event-decision'
import { decisionProbeResultText } from './project-event-decision-copy'

export function ProjectEventDecisionTestRow(props: {
  running: boolean
  result: ProjectEventDecisionProbeResult | null
  dirty: boolean
  disabled: boolean
  onTest: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.disabled || props.dirty}
          onClick={props.onTest}
        >
          {props.running
            ? translate('projectEventDecision.testing', 'Testing…')
            : translate('projectEventDecision.test', 'Test connection')}
        </Button>
        {props.dirty ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'projectEventDecision.saveFirst',
              'Save your changes before testing; the test uses the saved settings.'
            )}
          </p>
        ) : null}
      </div>
      {props.result ? (
        <p
          role="status"
          className={props.result.ok ? 'text-xs text-status-success' : 'text-xs text-destructive'}
        >
          {decisionProbeResultText(props.result)}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {translate(
            'projectEventDecision.testHelp',
            'Testing sends one small real decision request from this host. It may count against your provider quota.'
          )}
        </p>
      )}
    </div>
  )
}

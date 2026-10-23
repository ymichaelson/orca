import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { ForgeInboxProjectPolicy } from '../../../../shared/forge-inbox-config'
import {
  FORGE_BUDGET_KEYS,
  FORGE_EVENT_KEYS,
  type ForgeBudgetKey,
  type ForgeEventKey
} from './forge-inbox-settings-draft'

/** Keys stay literal so the localization catalogs can be generated from the source. */
function eventLabel(key: ForgeEventKey): string {
  switch (key) {
    case 'reviewRequests':
      return translate(
        'auto.components.forge-inbox.policy.event.reviewRequests',
        'Review requested'
      )
    case 'participatingMergeRequestUpdates':
      return translate(
        'auto.components.forge-inbox.policy.event.participatingMergeRequestUpdates',
        'Merge request I take part in changes'
      )
    case 'pipelineFailures':
      return translate(
        'auto.components.forge-inbox.policy.event.pipelineFailures',
        'Pipeline fails'
      )
    case 'issueMentions':
      return translate(
        'auto.components.forge-inbox.policy.event.issueMentions',
        'Issue mentions me'
      )
    case 'issueAssignments':
      return translate(
        'auto.components.forge-inbox.policy.event.issueAssignments',
        'Issue assigned to me'
      )
  }
}

const BUDGET_LIMITS: Record<ForgeBudgetKey, { min: number; max: number }> = {
  timeoutSeconds: { min: 10, max: 3600 },
  maxInputTokens: { min: 1000, max: 1_000_000 },
  maxOutputTokens: { min: 100, max: 200_000 },
  maxRunsPerHour: { min: 1, max: 600 }
}

function budgetLabel(key: ForgeBudgetKey): string {
  switch (key) {
    case 'timeoutSeconds':
      return translate('auto.components.forge-inbox.policy.budget.timeout', 'Timeout (seconds)')
    case 'maxInputTokens':
      return translate(
        'auto.components.forge-inbox.policy.budget.maxInputTokens',
        'Max input tokens'
      )
    case 'maxOutputTokens':
      return translate(
        'auto.components.forge-inbox.policy.budget.maxOutputTokens',
        'Max output tokens'
      )
    case 'maxRunsPerHour':
      return translate(
        'auto.components.forge-inbox.policy.budget.maxRunsPerHour',
        'Max runs per hour'
      )
  }
}

export function ForgeInboxProjectPolicyEditor({
  policy,
  onChange,
  onRemove
}: {
  policy: ForgeInboxProjectPolicy
  onChange: (next: ForgeInboxProjectPolicy) => void
  onRemove: () => void
}): React.JSX.Element {
  const update = (patch: Partial<ForgeInboxProjectPolicy>): void =>
    onChange({ ...policy, ...patch })
  const analysisReady =
    policy.agentId !== undefined &&
    policy.agentId !== '' &&
    policy.model !== undefined &&
    policy.model !== ''

  return (
    <div className="mt-3 flex flex-col gap-4 rounded-md border border-border/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span>{`!${policy.projectId}`}</span>
          <span className="text-muted-foreground">{policy.repoId}</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={policy.enabled}
              onCheckedChange={(checked) => update({ enabled: checked === true })}
            />
            {translate('auto.components.forge-inbox.policy.enabled', 'Enabled')}
          </label>
          <Button type="button" variant="ghost" size="xs" onClick={onRemove}>
            {translate('auto.components.forge-inbox.policy.remove', 'Remove')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`forge-agent-${policy.projectId}`}>
            {translate('auto.components.forge-inbox.policy.agent', 'Agent')}
          </Label>
          <Input
            id={`forge-agent-${policy.projectId}`}
            value={policy.agentId ?? ''}
            placeholder="claude"
            onChange={(event) =>
              update({ agentId: event.target.value === '' ? undefined : event.target.value })
            }
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`forge-model-${policy.projectId}`}>
            {translate('auto.components.forge-inbox.policy.model', 'Model')}
          </Label>
          <Input
            id={`forge-model-${policy.projectId}`}
            value={policy.model ?? ''}
            onChange={(event) =>
              update({ model: event.target.value === '' ? undefined : event.target.value })
            }
          />
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          className="mt-0.5"
          checked={policy.automaticAnalysis}
          disabled={!policy.automaticAnalysis && !analysisReady}
          onCheckedChange={(checked) => update({ automaticAnalysis: checked === true })}
        />
        <span>
          {translate(
            'auto.components.forge-inbox.policy.automaticAnalysis',
            'Analyze new events automatically in the background'
          )}
          {!analysisReady ? (
            <span className="block text-xs text-muted-foreground">
              {translate(
                'auto.components.forge-inbox.policy.analysisNeedsAgent',
                'Choose an Agent and a model first.'
              )}
            </span>
          ) : null}
        </span>
      </label>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`forge-rules-${policy.projectId}`}>
          {translate('auto.components.forge-inbox.policy.rules', 'Instructions for the Agent')}
        </Label>
        <Textarea
          id={`forge-rules-${policy.projectId}`}
          value={policy.rules}
          rows={3}
          onChange={(event) => update({ rules: event.target.value })}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium uppercase text-muted-foreground">
          {translate('auto.components.forge-inbox.policy.events', 'Events')}
        </legend>
        {FORGE_EVENT_KEYS.map((key) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={policy.events[key]}
              onCheckedChange={(checked) =>
                update({ events: { ...policy.events, [key]: checked === true } })
              }
            />
            {eventLabel(key)}
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase text-muted-foreground">
          {translate('auto.components.forge-inbox.policy.budgets', 'Limits')}
        </span>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {FORGE_BUDGET_KEYS.map((key) => {
            const limits = BUDGET_LIMITS[key]
            return (
              <div key={key} className="flex flex-col gap-1">
                <Label htmlFor={`forge-budget-${policy.projectId}-${key}`}>
                  {budgetLabel(key)}
                </Label>
                <Input
                  id={`forge-budget-${policy.projectId}-${key}`}
                  type="number"
                  min={limits.min}
                  max={limits.max}
                  value={String(policy.budgets[key])}
                  onChange={(event) =>
                    update({ budgets: { ...policy.budgets, [key]: Number(event.target.value) } })
                  }
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

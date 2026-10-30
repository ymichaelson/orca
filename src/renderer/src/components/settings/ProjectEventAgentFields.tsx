import { translate } from '@/i18n/i18n'
import type { getAgentCatalog } from '@/lib/agent-catalog'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { MAX_RULES_BYTES } from '../../../../shared/forge-inbox-config'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { ProjectEventModelField } from './ProjectEventModelField'
import type { ProjectEventAgentDraft } from './use-project-event-agent-settings'

const NO_AGENT = '__none__'

/** The four editable policy fields; the project settings page and the Add Project step both render these. */
export function ProjectEventAgentFields({
  idPrefix = 'project-event',
  repoId,
  target,
  draft,
  onChange,
  agents,
  detectedIds,
  rulesBytes,
  rulesRejected,
  showEnabled,
  disabled
}: {
  idPrefix?: string
  repoId: string
  /** The owner host's transport; the model list is read from it, never from the local host by default. */
  target: RuntimeClientTarget
  draft: ProjectEventAgentDraft
  onChange: (patch: Partial<ProjectEventAgentDraft>) => void
  agents: ReturnType<typeof getAgentCatalog>
  detectedIds: readonly string[] | null
  rulesBytes: number
  rulesRejected: boolean
  showEnabled: boolean
  disabled?: boolean
}): React.JSX.Element {
  const savedAgent = draft.agentId
  const savedAgentListed = savedAgent === null || agents.some((entry) => entry.id === savedAgent)
  return (
    <>
      {showEnabled ? (
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-enabled-${repoId}`}>
              {translate('projectEventAgent.enabled', 'Enable project event agent')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {translate(
                'projectEventAgent.enabledHelp',
                'The host keeps receiving events while this is off; only the agent work stops.'
              )}
            </p>
          </div>
          <Switch
            id={`${idPrefix}-enabled-${repoId}`}
            checked={draft.enabled}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ enabled: checked })}
            aria-label={translate('projectEventAgent.enabled', 'Enable project event agent')}
          />
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-agent-${repoId}`}>
          {translate('projectEventAgent.agent', 'Agent')}
        </Label>
        <Select
          value={savedAgent ?? NO_AGENT}
          disabled={disabled}
          onValueChange={(value) => {
            // Why: a model name belongs to one agent, so a new agent starts from its default.
            onChange({ agentId: value === NO_AGENT ? null : value, model: '' })
          }}
        >
          <SelectTrigger id={`${idPrefix}-agent-${repoId}`} size="sm" className="w-full max-w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_AGENT}>
              {translate('projectEventAgent.noAgent', 'No agent')}
            </SelectItem>
            {!savedAgentListed && savedAgent !== null ? (
              <SelectItem value={savedAgent}>
                {translate('projectEventAgent.savedAgentMissing', '{{agentId}} (not in this app)', {
                  agentId: savedAgent
                })}
              </SelectItem>
            ) : null}
            {agents.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {detectedIds !== null && !detectedIds.includes(entry.id)
                  ? translate(
                      'projectEventAgent.agentNotDetected',
                      '{{label}} — not detected on this host',
                      { label: entry.label }
                    )
                  : entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {translate(
            'projectEventAgent.agentHelp',
            'Undetected agents can still be selected; the host reports the real launch result when an event arrives.'
          )}
        </p>
      </div>
      <ProjectEventModelField
        key={savedAgent ?? NO_AGENT}
        id={`${idPrefix}-model-${repoId}`}
        target={target}
        agentId={savedAgent}
        model={draft.model}
        disabled={disabled}
        onChange={(model) => onChange({ model })}
      />
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-rules-${repoId}`}>
          {translate('projectEventAgent.rules', 'Rules')}
        </Label>
        <Textarea
          id={`${idPrefix}-rules-${repoId}`}
          value={draft.rules}
          spellCheck={false}
          rows={12}
          variant="code"
          disabled={disabled}
          aria-invalid={rulesRejected}
          onChange={(event) => onChange({ rules: event.target.value })}
        />
        <p className={rulesRejected ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
          {translate('projectEventAgent.rulesHelp', '{{used}} of {{limit}} bytes', {
            used: rulesBytes,
            limit: MAX_RULES_BYTES
          })}
        </p>
      </div>
    </>
  )
}

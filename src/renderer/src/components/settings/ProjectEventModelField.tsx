import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import {
  useProjectEventModelCatalog,
  type ProjectEventModelCatalog
} from './use-project-event-model-catalog'

const AGENT_DEFAULT = '__agent_default__'
const CUSTOM_MODEL = '__custom_model__'

function statusText(catalog: ProjectEventModelCatalog): string | null {
  switch (catalog.status) {
    case 'loading':
      return translate('projectEventAgent.modelStatus.loading', 'Loading the agent’s models…')
    case 'empty':
      return translate(
        'projectEventAgent.modelStatus.empty',
        'This host listed no models for the agent. Use the agent default or enter a model.'
      )
    case 'error':
      return translate(
        'projectEventAgent.modelStatus.error',
        'Could not read the model list from this host. Use the agent default or enter a model.'
      )
    case 'unlisted':
      return translate(
        'projectEventAgent.modelStatus.unlisted',
        'No model list is available for this agent. Use the agent default or enter a model.'
      )
    case 'ready':
      return catalog.workspaceSpecific
        ? translate(
            'projectEventAgent.modelStatus.workspaceSpecific',
            'This list may differ per workspace. If your model is missing, choose Custom model and enter it.'
          )
        : null
  }
}

/** Model picker over the owner host's catalog; `model` is '' for the agent default, as the draft stores it. */
export function ProjectEventModelField({
  id,
  target,
  agentId,
  model,
  disabled,
  onChange
}: {
  id: string
  target: RuntimeClientTarget
  agentId: string | null
  model: string
  disabled?: boolean
  onChange: (model: string) => void
}): React.JSX.Element {
  const catalog = useProjectEventModelCatalog(target, agentId)
  const [customRequested, setCustomRequested] = useState(false)
  const listed = catalog.status === 'ready' ? catalog.models : []
  const customMode =
    customRequested || (model !== '' && !listed.some((entry) => entry.id === model))
  const selected = customMode ? CUSTOM_MODEL : model === '' ? AGENT_DEFAULT : model
  const status = agentId === null ? null : statusText(catalog)

  const select = (value: string): void => {
    setCustomRequested(value === CUSTOM_MODEL)
    if (value !== CUSTOM_MODEL) {
      onChange(value === AGENT_DEFAULT ? '' : value)
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{translate('projectEventAgent.model', 'Model')}</Label>
      <Select value={selected} disabled={disabled} onValueChange={select}>
        <SelectTrigger id={id} size="sm" className="w-full max-w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AGENT_DEFAULT}>
            {translate('projectEventAgent.modelPlaceholder', 'Agent default')}
          </SelectItem>
          {listed.map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>
              {entry.label}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_MODEL}>
            {translate('projectEventAgent.modelCustom', 'Custom model…')}
          </SelectItem>
        </SelectContent>
      </Select>
      {customMode ? (
        <Input
          value={model}
          spellCheck={false}
          disabled={disabled}
          aria-label={translate('projectEventAgent.modelCustomInput', 'Custom model name')}
          onChange={(event) => {
            setCustomRequested(true)
            onChange(event.target.value)
          }}
        />
      ) : null}
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {status ??
          translate(
            'projectEventAgent.modelHelp',
            'Choose the model the agent should use. The agent default lets the agent pick.'
          )}
      </p>
    </div>
  )
}

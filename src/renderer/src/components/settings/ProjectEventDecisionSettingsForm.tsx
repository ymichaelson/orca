import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  decisionBaseUrl,
  projectEventDecisionSettingsSchema,
  type ProjectEventDecisionSettings
} from '../../../../shared/project-event-decision-settings'
import { decisionProviderDisclosure } from './project-event-decision-copy'

export function ProjectEventDecisionSettingsForm(props: {
  draft: ProjectEventDecisionSettings
  valid: boolean
  dirty: boolean
  disabled: boolean
  saving: boolean
  onUpdate: (patch: Partial<ProjectEventDecisionSettings>) => void
  onSave: () => void
}): React.JSX.Element {
  const { draft } = props
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        props.onSave()
      }}
    >
      <fieldset disabled={props.disabled} className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="event-decision-provider">
            {translate('projectEventDecision.provider', 'Provider')}
          </Label>
          <Select
            value={draft.provider}
            onValueChange={(value) => {
              if (value === 'jev' || value === 'laya') {
                props.onUpdate({ provider: value })
              }
            }}
          >
            <SelectTrigger id="event-decision-provider" size="sm" className="w-full max-w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="jev">Jev</SelectItem>
              <SelectItem value="laya">Laya</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {draft.provider === 'laya' ? (
          <div className="space-y-2">
            <Label htmlFor="event-decision-base-url">
              {translate('projectEventDecision.baseUrl', 'Laya service address')}
            </Label>
            <Input
              id="event-decision-base-url"
              value={draft.baseUrl}
              spellCheck={false}
              placeholder="http://127.0.0.1:8080/"
              aria-invalid={draft.baseUrl !== '' && decisionBaseUrl(draft.baseUrl) === null}
              onChange={(event) => props.onUpdate({ baseUrl: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              {translate(
                'projectEventDecision.baseUrlHelp',
                'This address belongs to the host, not to this window. A loopback address means the service runs on that host.'
              )}
            </p>
          </div>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="event-decision-model">
            {translate('projectEventDecision.model', 'Model')}
          </Label>
          <Input
            id="event-decision-model"
            value={draft.model}
            spellCheck={false}
            placeholder={translate('projectEventDecision.modelPlaceholder', 'Provider default')}
            aria-invalid={
              !projectEventDecisionSettingsSchema.shape.model.safeParse(draft.model).success
            }
            onChange={(event) => props.onUpdate({ model: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            {translate(
              'projectEventDecision.modelHelp',
              'Enter the model name; model discovery is not available for either provider yet. Leaving this empty uses the provider default.'
            )}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {decisionProviderDisclosure(draft.provider, draft.baseUrl)}
        </p>
        {!props.valid ? (
          <p role="alert" className="text-xs text-destructive">
            {translate(
              'projectEventDecision.invalid',
              'Enter a valid HTTP or HTTPS address without credentials, and a model name without control characters.'
            )}
          </p>
        ) : null}
        <Button type="submit" size="sm" disabled={!props.valid || !props.dirty || props.saving}>
          {translate('projectEventDecision.save', 'Save model settings')}
        </Button>
      </fieldset>
    </form>
  )
}

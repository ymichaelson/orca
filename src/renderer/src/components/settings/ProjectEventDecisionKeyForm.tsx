import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ProjectEventDecisionProvider } from '../../../../shared/project-event-decision'

function keyMissingText(provider: ProjectEventDecisionProvider): string {
  return provider === 'jev'
    ? translate(
        'projectEventDecision.keyMissingJev',
        'No API key is saved. Jev requires one before decisions can run.'
      )
    : translate(
        'projectEventDecision.keyMissingLaya',
        'No API key is saved. Add one only if your Laya deployment requires authentication.'
      )
}

export function ProjectEventDecisionKeyForm(props: {
  provider: ProjectEventDecisionProvider
  hasApiKey: boolean
  hasSealedKey: boolean
  protectionAvailable: boolean
  keyDraft: string
  keyValid: boolean
  busy: boolean
  keySaving: boolean
  onKeyDraft: (value: string) => void
  onSaveKey: () => void
  onClearKey: () => void
}): React.JSX.Element {
  return (
    <form
      className="space-y-3 border-t border-border/60 pt-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (props.keyValid && props.protectionAvailable) {
          props.onSaveKey()
        }
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="event-decision-api-key">
          {translate('projectEventDecision.apiKey', 'API key')}
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="event-decision-api-key"
            type="password"
            value={props.keyDraft}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 basis-56"
            disabled={props.busy || !props.protectionAvailable}
            aria-invalid={props.keyDraft !== '' && !props.keyValid}
            onChange={(event) => props.onKeyDraft(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={!props.keyValid || props.busy || !props.protectionAvailable}
          >
            {translate('projectEventDecision.saveKey', 'Save key')}
          </Button>
          {props.hasApiKey || props.hasSealedKey ? (
            // Why not in a disabled fieldset: clearing writes no secret, so it must stay available
            // on a host whose keyring broke — otherwise the saved key could never be removed.
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={props.busy || props.keySaving}
              onClick={props.onClearKey}
            >
              {translate('projectEventDecision.clearKey', 'Clear key')}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {props.hasApiKey
            ? translate(
                'projectEventDecision.keyPresent',
                'A key is saved on this host. It is never shown again; save a new one to replace it.'
              )
            : props.hasSealedKey
              ? translate(
                  'projectEventDecision.keyUnreadable',
                  'A key is saved on this host but cannot be read here. Restore keyring access, or clear it and save a new key.'
                )
              : keyMissingText(props.provider)}
        </p>
      </div>
      {props.protectionAvailable ? null : (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'projectEventDecision.protectionUnavailable',
            'This host cannot seal credentials with OS-protected encryption, so saving an API key is disabled here. Fix keyring support on the host, then retry.'
          )}
        </p>
      )}
    </form>
  )
}

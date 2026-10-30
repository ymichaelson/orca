import { useEffect, useState } from 'react'
import { BrainCircuit } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { ProjectEventDecisionProvider } from '../../../../shared/project-event-decision'
import {
  projectEventDecisionKeySchema,
  projectEventDecisionSettingsSchema,
  type ProjectEventDecisionSettings,
  type ProjectEventDecisionSettingsView
} from '../../../../shared/project-event-decision-settings'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { ProjectEventDecisionKeyForm } from './ProjectEventDecisionKeyForm'
import { ProjectEventDecisionSettingsForm } from './ProjectEventDecisionSettingsForm'
import { ProjectEventDecisionTestRow } from './ProjectEventDecisionTestRow'
import { SettingsHostScopeUnavailableNotice } from './SettingsHostScopePicker'
import type { SettingsHostScope } from './settings-host-scope'
import { useProjectEventDecisionSettings } from './use-project-event-decision-settings'

export type ProjectEventDecisionSettingsCardProps = {
  hostScope: SettingsHostScope
  runtimeEnvironments: readonly PublicKnownRuntimeEnvironment[]
  onBusyChange?: (busy: boolean) => void
}

export function ProjectEventDecisionSettingsCard(
  props: ProjectEventDecisionSettingsCardProps
): React.JSX.Element {
  const target = props.hostScope.target
  const ownerKey = target.kind === 'environment' ? `environment:${target.environmentId}` : 'local'
  const hostLabel =
    target.kind === 'environment'
      ? (props.runtimeEnvironments.find((environment) => environment.id === target.environmentId)
          ?.name ?? target.environmentId)
      : getLocalExecutionHostLabel()
  return props.hostScope.available ? (
    <DecisionHostCard key={ownerKey} {...props} hostLabel={hostLabel} />
  ) : (
    <SettingsHostScopeUnavailableNotice />
  )
}

function sameSettings(
  left: ProjectEventDecisionSettings,
  right: ProjectEventDecisionSettings
): boolean {
  return (
    left.provider === right.provider && left.model === right.model && left.baseUrl === right.baseUrl
  )
}

function savedSettings(view: ProjectEventDecisionSettingsView): ProjectEventDecisionSettings {
  return { provider: view.provider, model: view.model, baseUrl: view.baseUrl }
}

function DecisionHostCard(
  props: ProjectEventDecisionSettingsCardProps & { hostLabel: string }
): React.JSX.Element {
  const model = useProjectEventDecisionSettings(props.hostScope.target)
  const [draft, setDraft] = useState<ProjectEventDecisionSettings | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const saved = model.view === null ? null : savedSettings(model.view.settings)
  // Why a null draft means saved: unsaved edits survive a key save, and a save resets the draft.
  const current = draft ?? saved
  const keysSaved = model.view?.settings.apiKeysSaved
  const keysSealed = model.view?.settings.apiKeysSealed
  const keySavedFor = (provider: ProjectEventDecisionProvider): boolean =>
    keysSaved?.[provider] === true
  const keySealedFor = (provider: ProjectEventDecisionProvider): boolean =>
    keysSealed?.[provider] === true
  const formHasApiKey = current !== null && keySavedFor(current.provider)
  const formKeySealed = current !== null && keySealedFor(current.provider)
  const valid = current !== null && projectEventDecisionSettingsSchema.safeParse(current).success
  const dirty = draft !== null && saved !== null && !sameSettings(draft, saved)
  const keyValid = keyDraft !== '' && projectEventDecisionKeySchema.safeParse(keyDraft).success
  const busy = model.loading || model.saving || model.keySaving || model.probe.running
  const protectionAvailable = model.view?.protection === 'available'
  const ready = model.ready
  const { onBusyChange } = props
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])
  const failed = model.error !== null && model.view === null
  const statusLabel = model.loading
    ? translate('projectEventDecision.status.loading', 'Loading…')
    : model.loadState === 'unsupported'
      ? translate('projectEventDecision.status.unsupported', 'Unsupported host')
      : model.loadState === 'unattached'
        ? translate('projectEventDecision.status.unattached', 'Project events not running')
        : failed
          ? translate('projectEventDecision.status.unavailable', 'Unavailable')
          : ready
            ? translate('projectEventDecision.status.ready', 'Ready')
            : translate('projectEventDecision.status.needsSetup', 'Needs setup')
  const statusTone =
    model.loadState === 'unsupported' ||
    model.loadState === 'unattached' ||
    failed ||
    model.error !== null
      ? 'attention'
      : ready && !model.loading
        ? 'connected'
        : 'neutral'

  return (
    <IntegrationCardShell
      icon={<BrainCircuit className="size-5" />}
      name={translate('projectEventDecision.title', 'Event decision model')}
      description={translate(
        'projectEventDecision.host',
        'Quick decisions for project event agents on {{host}}',
        { host: props.hostLabel }
      )}
      statusLabel={statusLabel}
      statusTone={statusTone}
      checking={model.loading}
      settingsSectionId="agents-event-decision"
      actions={
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={model.refresh}>
          {translate('projectEventDecision.refresh', 'Refresh')}
        </Button>
      }
    >
      <IntegrationCardDetails>
        <p className="text-xs text-muted-foreground">
          {translate(
            'projectEventDecision.intro',
            'The decision model chooses a next step for each event. It needs no shell, repository write access or GitLab write credential; only your project rules and bounded event facts are sent.'
          )}
        </p>
        {model.loadState === 'unsupported' ? (
          <p role="alert" className="text-xs text-destructive">
            {translate(
              'projectEventDecision.unsupported',
              'This host does not support event decision settings. Update the host and retry.'
            )}
          </p>
        ) : null}
        {model.loadState === 'unattached' ? (
          <p role="alert" className="text-xs text-destructive">
            {translate(
              'projectEventDecision.unattached',
              'Project events are not running on this host yet, so its decision model cannot be edited here. Start Orca on this host and retry.'
            )}
          </p>
        ) : null}
        {model.error ? (
          <p role="alert" className="text-xs text-destructive">
            {model.error}
          </p>
        ) : null}
        {current === null ? null : (
          <>
            <ProjectEventDecisionSettingsForm
              draft={current}
              valid={valid}
              dirty={dirty}
              disabled={busy}
              saving={model.saving}
              onUpdate={(patch) => {
                if (patch.provider && patch.provider !== current.provider) {
                  // Why: a key typed for one provider must never be saved into the other's slot.
                  setKeyDraft('')
                }
                setDraft((edited) => ({ ...(edited ?? current), ...patch }))
              }}
              onSave={() => {
                if (!valid || !dirty) {
                  return
                }
                void model.saveSettings(current).then((done) => {
                  if (done) {
                    setDraft(null)
                    toast.success(
                      translate('projectEventDecision.saved', 'Event decision settings saved')
                    )
                  }
                })
              }}
            />
            <ProjectEventDecisionKeyForm
              provider={current.provider}
              hasApiKey={formHasApiKey}
              hasSealedKey={formKeySealed}
              protectionAvailable={protectionAvailable}
              keyDraft={keyDraft}
              keyValid={keyValid}
              busy={busy}
              keySaving={model.keySaving}
              onKeyDraft={setKeyDraft}
              onSaveKey={() => {
                void model.saveApiKey(current.provider, keyDraft).then((done) => {
                  if (done) {
                    setKeyDraft('')
                    toast.success(
                      translate('projectEventDecision.keySaved', 'API key saved on this host')
                    )
                  }
                })
              }}
              onClearKey={() => {
                void model.clearApiKey(current.provider).then((done) => {
                  if (done) {
                    toast.success(
                      translate('projectEventDecision.keyCleared', 'API key removed from this host')
                    )
                  }
                })
              }}
            />
            <ProjectEventDecisionTestRow
              running={model.probe.running}
              result={model.probe.result}
              // Why the key too: a probe reads the saved key, so an unsaved key would test the old one.
              dirty={dirty || keyDraft !== ''}
              disabled={busy}
              onTest={() => void model.testConnection()}
            />
          </>
        )}
      </IntegrationCardDetails>
    </IntegrationCardShell>
  )
}

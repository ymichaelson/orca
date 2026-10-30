import { useEffect, useState } from 'react'
import { Webhook } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import {
  projectEventReceiverSettingsSchema,
  type ProjectEventReceiverSettings
} from '../../../../shared/project-event-receiver-settings'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { receiverListenerErrorText } from './project-event-receiver-error-text'
import { SettingsHostScopeUnavailableNotice } from './SettingsHostScopePicker'
import type { SettingsHostScope } from './settings-host-scope'
import { useWebhookHostSettings } from './use-webhook-host-settings'

export type WebhookIntegrationCardProps = {
  hostScope: SettingsHostScope
  runtimeEnvironments: readonly PublicKnownRuntimeEnvironment[]
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
  onBusyChange?: (busy: boolean) => void
}

export function WebhookIntegrationCard(props: WebhookIntegrationCardProps): React.JSX.Element {
  const target = props.hostScope.target
  const ownerKey = target.kind === 'environment' ? `environment:${target.environmentId}` : 'local'
  const hostLabel =
    target.kind === 'environment'
      ? (props.runtimeEnvironments.find((environment) => environment.id === target.environmentId)
          ?.name ?? target.environmentId)
      : getLocalExecutionHostLabel()
  return props.hostScope.available ? (
    <WebhookHostCard key={ownerKey} {...props} hostLabel={hostLabel} />
  ) : (
    <SettingsHostScopeUnavailableNotice />
  )
}

function WebhookHostCard(
  props: WebhookIntegrationCardProps & { hostLabel: string }
): React.JSX.Element {
  const model = useWebhookHostSettings(props.hostScope.target, props.settings, props.updateSettings)
  const [draft, setDraft] = useState<ProjectEventReceiverSettings | null>(null)
  const [port, setPort] = useState('')
  const busy = model.loading || model.saving
  const { onBusyChange } = props
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])
  useEffect(() => {
    setDraft(model.settings)
    setPort(model.settings === null ? '' : String(model.settings.port))
  }, [model.settings])
  const candidate =
    draft === null ? null : { ...draft, port: /^\d+$/.test(port) ? Number(port) : Number.NaN }
  const valid =
    candidate !== null && projectEventReceiverSettingsSchema.safeParse(candidate).success
  const dirty = candidate !== null && JSON.stringify(candidate) !== JSON.stringify(model.settings)
  const listener = model.status && 'listener' in model.status ? model.status.listener : null
  const externalBaseUrl = model.settings?.externalBaseUrl.trim() ?? ''
  const failed = Boolean(
    model.error || model.statusError || listener?.error || (model.status && !model.status.available)
  )
  // GitLab cannot deliver anywhere without an external callback address, even while listening.
  const callbackMissing = !failed && listener?.listening === true && externalBaseUrl === ''
  const statusLabel = model.loading
    ? translate('webhook.status.loading', 'Loading…')
    : model.saving
      ? translate('webhook.status.applying', 'Applying changes…')
      : failed
        ? translate('webhook.status.failure', 'Unavailable or failed')
        : callbackMissing
          ? translate(
              'webhook.status.callbackMissing',
              'Listening on port {{port}}, but no external callback address is configured',
              { port: listener?.port ?? '' }
            )
          : listener?.listening
            ? translate('webhook.status.listening', 'Listening on port {{port}}', {
                port: listener.port ?? ''
              })
            : listener?.enabled
              ? translate('webhook.status.starting', 'Starting / not listening')
              : listener
                ? translate('webhook.status.disabled', 'Disabled — not receiving')
                : translate('webhook.status.unknown', 'Status unknown')
  const statusTone = failed || (!model.saving && callbackMissing) ? 'attention' : 'neutral'
  const update = (patch: Partial<ProjectEventReceiverSettings>): void => {
    if (draft) {
      setDraft({ ...draft, ...patch })
    }
  }
  return (
    <IntegrationCardShell
      icon={<Webhook className="size-5" />}
      name={translate('webhook.settings.title', 'Webhook')}
      description={translate('webhook.settings.host', 'Event receiver on {{host}}', {
        host: props.hostLabel
      })}
      statusLabel={statusLabel}
      statusTone={statusTone}
      settingsSectionId="integrations-webhook"
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={model.loading || model.saving || dirty}
          onClick={model.refresh}
        >
          {translate('webhook.settings.refresh', 'Refresh / retry')}
        </Button>
      }
    >
      <IntegrationCardDetails>
        <p className="text-xs text-muted-foreground">
          {translate(
            'webhook.settings.transport',
            'The listener uses HTTP, not TLS. An HTTPS external address requires a separately configured reverse proxy. Listening does not verify GitLab connectivity.'
          )}
        </p>
        {model.error || model.statusError || listener?.error ? (
          <p role="alert" className="text-xs text-destructive">
            {model.error ?? model.statusError ?? receiverListenerErrorText(listener?.error ?? null)}
          </p>
        ) : null}
        {draft === null ? null : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (!valid || !candidate) {
                return
              }
              void model.save(candidate).then((saved) => {
                if (saved) {
                  toast.success(translate('webhook.settings.saved', 'Webhook settings saved'))
                }
              })
            }}
          >
            <fieldset disabled={model.loading || model.saving} className="space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.enabled}
                  onCheckedChange={(checked) => update({ enabled: checked === true })}
                />
                {translate('webhook.settings.enabled', 'Enable event receiver')}
              </label>
              <div className="space-y-2">
                <Label htmlFor="webhook-bind">
                  {translate('webhook.settings.bind', 'Listen IP address')}
                </Label>
                <Input
                  id="webhook-bind"
                  value={draft.bindAddress}
                  spellCheck={false}
                  aria-invalid={
                    !projectEventReceiverSettingsSchema.shape.bindAddress.safeParse(
                      draft.bindAddress
                    ).success
                  }
                  onChange={(event) => update({ bindAddress: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'webhook.settings.bindHelp',
                    'Use an IPv4 or IPv6 address. This is not the callback address GitLab should use.'
                  )}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="webhook-port">
                  {translate('webhook.settings.port', 'Exact listen port')}
                </Label>
                <Input
                  id="webhook-port"
                  inputMode="numeric"
                  value={port}
                  aria-invalid={!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535}
                  onChange={(event) => setPort(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'webhook.settings.portHelp',
                    'Choose 1–65535. If the port is occupied, startup fails; Orca will not choose another port.'
                  )}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="webhook-external">
                  {translate('webhook.settings.external', 'External base URL')}
                </Label>
                <Input
                  id="webhook-external"
                  value={draft.externalBaseUrl}
                  spellCheck={false}
                  aria-invalid={
                    !projectEventReceiverSettingsSchema.shape.externalBaseUrl.safeParse(
                      draft.externalBaseUrl
                    ).success
                  }
                  onChange={(event) => update({ externalBaseUrl: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'webhook.settings.externalHelp',
                    'Set the HTTP or HTTPS address GitLab can reach. Do not use a wildcard bind address. Leaving this empty means the callback address is not configured.'
                  )}
                </p>
              </div>
              <label className="flex items-start gap-2 text-xs">
                <Checkbox
                  checked={draft.acknowledgeExternalPlaintextHttp}
                  onCheckedChange={(checked) =>
                    update({ acknowledgeExternalPlaintextHttp: checked === true })
                  }
                />
                <span>
                  {translate(
                    'webhook.settings.acknowledge',
                    'I understand that external HTTP traffic is unencrypted, and exposing the listener beyond loopback can expose event payloads. I will restrict access or configure a secure reverse proxy.'
                  )}
                </span>
              </label>
              {!valid ? (
                <p role="alert" className="text-xs text-destructive">
                  {translate(
                    'webhook.settings.invalid',
                    'Enter a valid IP address, port and external URL, and acknowledge external plaintext exposure before enabling.'
                  )}
                </p>
              ) : null}
              <Button type="submit" size="sm" disabled={!valid || !dirty || model.saving}>
                {translate('webhook.settings.save', 'Save Webhook settings')}
              </Button>
            </fieldset>
          </form>
        )}
      </IntegrationCardDetails>
    </IntegrationCardShell>
  )
}

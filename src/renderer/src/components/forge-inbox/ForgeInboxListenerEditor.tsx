import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import type { ForgeInboxConfig } from '../../../../shared/forge-inbox-config'

const LOOPBACK = new Set(['127.0.0.1', '::1'])

/** The host refuses an external bind without the explicit plaintext acknowledgement, so surface it here. */
export function ForgeInboxListenerEditor({
  draft,
  onChange
}: {
  draft: ForgeInboxConfig
  onChange: (next: ForgeInboxConfig) => void
}): React.JSX.Element {
  const listener = draft.listener
  const external = !LOOPBACK.has(listener.bindAddress.toLowerCase())
  const update = (patch: Partial<typeof listener>): void =>
    onChange({ ...draft, listener: { ...listener, ...patch } })

  return (
    <section className="rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold leading-6">
        {translate('auto.components.forge-inbox.listener.title', 'Webhook listener')}
      </h3>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <Checkbox
          className="mt-0.5"
          checked={listener.enabled}
          onCheckedChange={(checked) => update({ enabled: checked === true })}
        />
        <span>
          {translate(
            'auto.components.forge-inbox.listener.enabled',
            'Receive GitLab webhooks on this host'
          )}
        </span>
      </label>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="forge-listener-bind">
            {translate('auto.components.forge-inbox.listener.bindAddress', 'Bind address')}
          </Label>
          <Input
            id="forge-listener-bind"
            value={listener.bindAddress}
            spellCheck={false}
            onChange={(event) => update({ bindAddress: event.target.value })}
            onBlur={(event) => update({ bindAddress: event.target.value.trim() })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="forge-listener-port">
            {translate('auto.components.forge-inbox.listener.port', 'Port')}
          </Label>
          <Input
            id="forge-listener-port"
            type="number"
            min={1}
            max={65535}
            value={String(listener.port)}
            onChange={(event) => update({ port: Number(event.target.value) })}
          />
        </div>
      </div>

      <label className="mt-3 flex items-start gap-2 text-sm">
        <Checkbox
          className="mt-0.5"
          checked={listener.acknowledgeExternalPlaintextHttp}
          onCheckedChange={(checked) =>
            update({ acknowledgeExternalPlaintextHttp: checked === true })
          }
        />
        <span>
          {translate(
            'auto.components.forge-inbox.listener.plaintextAck',
            'I understand this address is outside loopback and GitLab will reach it over plaintext HTTP'
          )}
        </span>
      </label>
      {external ? (
        <p className="mt-2 text-xs text-destructive">
          {translate(
            'auto.components.forge-inbox.listener.externalWarning',
            'Webhook payloads and the shared token will cross the network unencrypted. Prefer loopback with a reverse proxy.'
          )}
        </p>
      ) : null}
    </section>
  )
}

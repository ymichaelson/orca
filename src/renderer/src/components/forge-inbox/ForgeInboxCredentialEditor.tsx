import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import {
  FORGE_CREDENTIAL_KINDS,
  type ForgeCredentialKind,
  type ForgeCredentialStatus
} from '../../../../shared/forge-inbox-config'
import type { ForgeInboxCredentialWriteOutcome } from '../../../../shared/forge-inbox-rpc-types'
import { forgeWriteFailureMessage } from './forge-inbox-settings-messages'

function credentialLabel(kind: ForgeCredentialKind): string {
  switch (kind) {
    case 'webhook':
      return translate('auto.components.forge-inbox.credential.webhook', 'Webhook token')
    case 'api-read':
      return translate('auto.components.forge-inbox.credential.apiRead', 'Read-only API token')
    case 'api-write':
      return translate(
        'auto.components.forge-inbox.credential.apiWrite',
        'Write API token (optional)'
      )
  }
}

type Notice = { text: string; retryKind: ForgeCredentialKind | null }

export function ForgeInboxCredentialEditor({
  credentials,
  onSet,
  onClear
}: {
  credentials: ForgeCredentialStatus[]
  onSet: (
    kind: ForgeCredentialKind,
    secret: string,
    allowUnprotectedStorage: boolean
  ) => Promise<ForgeInboxCredentialWriteOutcome>
  onClear: (kind: ForgeCredentialKind) => Promise<ForgeInboxCredentialWriteOutcome>
}): React.JSX.Element {
  const [secrets, setSecrets] = useState<Partial<Record<ForgeCredentialKind, string>>>({})
  const [busy, setBusy] = useState<ForgeCredentialKind | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const statusFor = (kind: ForgeCredentialKind): ForgeCredentialStatus | undefined =>
    credentials.find((credential) => credential.kind === kind)

  const run = async (
    kind: ForgeCredentialKind,
    write: () => Promise<ForgeInboxCredentialWriteOutcome>
  ): Promise<void> => {
    setBusy(kind)
    setNotice(null)
    try {
      const outcome = await write()
      if (outcome.ok) {
        setSecrets((current) => ({ ...current, [kind]: '' }))
      } else if (outcome.reason === 'unprotected-storage') {
        setNotice({ text: forgeWriteFailureMessage(outcome), retryKind: kind })
      } else {
        setNotice({ text: forgeWriteFailureMessage(outcome), retryKind: null })
      }
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : String(error),
        retryKind: null
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium uppercase text-muted-foreground">
        {translate('auto.components.forge-inbox.credential.title', 'Credentials')}
      </span>
      {FORGE_CREDENTIAL_KINDS.map((kind) => {
        const status = statusFor(kind)
        const secret = secrets[kind] ?? ''
        const pending = busy === kind
        return (
          <div key={kind} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`forge-secret-${kind}`}>{credentialLabel(kind)}</Label>
              {status === undefined ? (
                <Badge variant="outline">
                  {translate('auto.components.forge-inbox.credential.missing', 'Not set')}
                </Badge>
              ) : (
                <Badge variant={status.protection === 'sealed' ? 'secondary' : 'destructive'}>
                  {status.protection === 'sealed'
                    ? translate('auto.components.forge-inbox.credential.sealed', 'Protected')
                    : translate(
                        'auto.components.forge-inbox.credential.plaintext',
                        'Stored unencrypted'
                      )}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Input
                id={`forge-secret-${kind}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={secret}
                placeholder={
                  status === undefined
                    ? ''
                    : translate(
                        'auto.components.forge-inbox.credential.replaceHint',
                        'Enter a new token to replace it'
                      )
                }
                onChange={(event) =>
                  setSecrets((current) => ({ ...current, [kind]: event.target.value }))
                }
              />
              <Button
                type="button"
                size="sm"
                disabled={pending || secret === ''}
                // Why no trim: the host stores the secret byte-exact or refuses it, never silently altered.
                onClick={() => void run(kind, () => onSet(kind, secret, false))}
              >
                {translate('auto.components.forge-inbox.credential.save', 'Save')}
              </Button>
              {status === undefined ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => void run(kind, () => onClear(kind))}
                >
                  {translate('auto.components.forge-inbox.credential.clear', 'Clear')}
                </Button>
              )}
            </div>
          </div>
        )
      })}
      {notice === null ? null : (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          <p>{notice.text}</p>
          {notice.retryKind === null ? null : (
            <Button
              type="button"
              size="xs"
              variant="destructive"
              className="mt-2"
              disabled={busy !== null || (secrets[notice.retryKind] ?? '') === ''}
              onClick={() => {
                const kind = notice.retryKind
                if (kind === null) {
                  return
                }
                void run(kind, () => onSet(kind, secrets[kind] ?? '', true))
              }}
            >
              {translate(
                'auto.components.forge-inbox.credential.acceptUnprotected',
                'Store it unencrypted anyway'
              )}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

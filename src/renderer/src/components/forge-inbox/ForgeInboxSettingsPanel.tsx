import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { parseForgeInboxConfig, type ForgeInboxConfig } from '../../../../shared/forge-inbox-config'
import type { ForgeInboxConfigView } from '../../../../shared/forge-inbox-rpc-types'
import {
  clearForgeInboxCredential,
  readForgeInboxConfig,
  setForgeInboxCredential,
  updateForgeInboxConfig
} from '../../runtime/forge-inbox-client'
import { ForgeInboxInstanceEditor } from './ForgeInboxInstanceEditor'
import { ForgeInboxListenerEditor } from './ForgeInboxListenerEditor'
import { forgeWriteFailureMessage } from './forge-inbox-settings-messages'
import { cloneForgeConfig } from './forge-inbox-settings-draft'

const INSTANCE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const LOOPBACK = new Set(['127.0.0.1', '::1'])

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ForgeInboxSettingsPanel({
  onClose,
  onChanged,
  onDirtyChange
}: {
  onClose: () => void
  onChanged: () => void
  onDirtyChange: (dirty: boolean) => void
}): React.JSX.Element {
  const repos = useAppStore((state) => state.repos)
  const [view, setView] = useState<ForgeInboxConfigView | null>(null)
  const [base, setBase] = useState<ForgeInboxConfig | null>(null)
  const [draft, setDraft] = useState<ForgeInboxConfig | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [newInstanceId, setNewInstanceId] = useState('')
  const [newInstanceUrl, setNewInstanceUrl] = useState('')

  const load = useCallback(async (keepDraft: boolean) => {
    try {
      const next = await readForgeInboxConfig()
      setView(next)
      setBase(cloneForgeConfig(next.config))
      setDraft((current) =>
        keepDraft && current !== null ? current : cloneForgeConfig(next.config)
      )
      setNotice(null)
    } catch (error) {
      setNotice(errorText(error))
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  const dirty = useMemo(
    () => draft !== null && base !== null && JSON.stringify(draft) !== JSON.stringify(base),
    [draft, base]
  )
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  // Remote connections execute elsewhere; the inbox listener runs on this window's host.
  const candidateRepos = useMemo(
    () => repos.filter((repo) => (repo.connectionId ?? null) === null),
    [repos]
  )

  const save = async (): Promise<void> => {
    if (view === null || draft === null) {
      return
    }
    const parsed = parseForgeInboxConfig(draft)
    if (!parsed.ok) {
      setNotice(forgeWriteFailureMessage({ reason: 'invalid-config', message: parsed.message }))
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      const outcome = await updateForgeInboxConfig(
        view.ownerHostId,
        view.configRevision,
        parsed.config
      )
      if (!outcome.ok) {
        setNotice(forgeWriteFailureMessage(outcome))
        return
      }
      await load(false)
      onChanged()
    } catch (error) {
      setNotice(errorText(error))
    } finally {
      setSaving(false)
    }
  }

  const runCredentialWrite = async (
    write: (expectedRevision: number) => ReturnType<typeof setForgeInboxCredential>
  ): ReturnType<typeof setForgeInboxCredential> => {
    if (view === null) {
      throw new Error('settings are not loaded yet')
    }
    const outcome = await write(view.configRevision)
    if (outcome.ok) {
      await load(true)
      onChanged()
    } else {
      setNotice(forgeWriteFailureMessage(outcome))
    }
    return outcome
  }

  const listener = draft?.listener
  const webhookBase =
    listener === undefined
      ? ''
      : `http://${listener.bindAddress.includes(':') ? `[${listener.bindAddress}]` : listener.bindAddress}:${listener.port}/webhooks/gitlab/`

  const canAddInstance =
    INSTANCE_ID.test(newInstanceId) &&
    draft !== null &&
    !draft.instances.some((instance) => instance.id === newInstanceId)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="xs" onClick={onClose}>
            {translate('auto.components.forge-inbox.settings.back', 'Back to inbox')}
          </Button>
          {dirty ? (
            <span className="text-xs text-muted-foreground">
              {translate('auto.components.forge-inbox.settings.unsaved', 'Unsaved changes')}
            </span>
          ) : null}
        </div>
        <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          {saving
            ? translate('auto.components.forge-inbox.settings.saving', 'Saving…')
            : translate('auto.components.forge-inbox.settings.save', 'Save settings')}
        </Button>
      </div>

      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {notice === null ? null : (
          <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            <p>{notice}</p>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="mt-1"
              onClick={() => void load(false)}
            >
              {translate('auto.components.forge-inbox.settings.reload', 'Reload from host')}
            </Button>
          </div>
        )}
        {view === null || draft === null ? (
          <p className="text-sm text-muted-foreground">
            {translate('auto.components.forge-inbox.settings.loading', 'Loading settings…')}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.forge-inbox.settings.hostScope',
                'These settings belong to host {{hostId}} and are stored on it.',
                { hostId: view.ownerHostId }
              )}
            </p>

            <ForgeInboxListenerEditor draft={draft} onChange={(next) => setDraft(next)} />
            {!LOOPBACK.has(listener?.bindAddress.toLowerCase() ?? '') ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.forge-inbox.settings.externalBind',
                  'An external bind address is reachable from your network; GitLab must be able to open it.'
                )}
              </p>
            ) : null}

            {draft.instances.map((instance, index) => (
              <ForgeInboxInstanceEditor
                key={`${instance.id}:${view.configRevision}`}
                instance={instance}
                webhookUrl={`${webhookBase}${instance.id}`}
                repos={candidateRepos}
                credentials={view.credentials.filter(
                  (credential) => credential.instanceId === instance.id
                )}
                onChange={(next) =>
                  setDraft({
                    ...draft,
                    instances: draft.instances.map((current, position) =>
                      position === index ? next : current
                    )
                  })
                }
                onRemove={() =>
                  setDraft({
                    ...draft,
                    instances: draft.instances.filter((_, position) => position !== index)
                  })
                }
                onSetCredential={(kind, secret, allowUnprotectedStorage) =>
                  runCredentialWrite((expectedRevision) =>
                    setForgeInboxCredential(view.ownerHostId, {
                      instanceId: instance.id,
                      kind,
                      expectedRevision,
                      secret,
                      allowUnprotectedStorage
                    })
                  )
                }
                onClearCredential={(kind) =>
                  runCredentialWrite((expectedRevision) =>
                    clearForgeInboxCredential(view.ownerHostId, {
                      instanceId: instance.id,
                      kind,
                      expectedRevision
                    })
                  )
                }
              />
            ))}

            <section className="rounded-lg border border-dashed border-border p-4">
              <span className="text-xs font-medium uppercase text-muted-foreground">
                {translate(
                  'auto.components.forge-inbox.settings.addInstance',
                  'Add GitLab instance'
                )}
              </span>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto]">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="forge-new-instance-id">
                    {translate('auto.components.forge-inbox.settings.instanceId', 'Instance ID')}
                  </Label>
                  <Input
                    id="forge-new-instance-id"
                    value={newInstanceId}
                    spellCheck={false}
                    placeholder="gitlab"
                    onChange={(event) => setNewInstanceId(event.target.value.toLowerCase())}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="forge-new-instance-url">
                    {translate('auto.components.forge-inbox.settings.instanceUrl', 'GitLab URL')}
                  </Label>
                  <Input
                    id="forge-new-instance-url"
                    value={newInstanceUrl}
                    spellCheck={false}
                    placeholder="https://gitlab.example.com"
                    onChange={(event) => setNewInstanceUrl(event.target.value)}
                  />
                </div>
                <div className="flex items-end">
                  <Button
                    type="button"
                    size="sm"
                    disabled={!canAddInstance || newInstanceUrl.trim() === ''}
                    onClick={() => {
                      setDraft({
                        ...draft,
                        instances: [
                          ...draft.instances,
                          {
                            id: newInstanceId,
                            displayName: newInstanceId,
                            baseUrl: newInstanceUrl.trim(),
                            allowInsecureHttpApi: false,
                            allowLegacyPayloadDigestDedupe: false,
                            usernames: [],
                            projects: []
                          }
                        ]
                      })
                      setNewInstanceId('')
                      setNewInstanceUrl('')
                    }}
                  >
                    {translate('auto.components.forge-inbox.settings.add', 'Add')}
                  </Button>
                </div>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

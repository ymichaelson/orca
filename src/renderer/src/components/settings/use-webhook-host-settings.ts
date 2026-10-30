import { useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { readForgeInboxStatus, retryForgeInboxReceiver } from '@/runtime/forge-inbox-client'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ForgeInboxStatus } from '../../../../shared/forge-inbox-rpc-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  normalizeProjectEventReceiverSettings,
  parseProjectEventReceiverSettings,
  type ProjectEventReceiverSettings
} from '../../../../shared/project-event-receiver-settings'
import { PROJECT_EVENT_RECEIVER_RUNTIME_CAPABILITY } from '../../../../shared/project-event-receiver-runtime-capabilities'

/** Client-authored text is safe to show; host errors may carry internal codes and must not be. */
class HostSettingsTextError extends Error {}

function failureText(failure: unknown): string {
  return failure instanceof HostSettingsTextError
    ? failure.message
    : translate(
        'webhook.error.hostUnavailable',
        'Could not complete the request. Retry; if it keeps failing, check the connection to the host.'
      )
}

function readReceiver(result: { settings: Partial<GlobalSettings> }): ProjectEventReceiverSettings {
  if (result.settings.projectEventReceiver === undefined) {
    throw new HostSettingsTextError(
      translate(
        'webhook.settings.missing',
        'This host did not return Webhook settings. Update the host and retry.'
      )
    )
  }
  // Why normalize, not parse: a newer host may add fields an older client has never seen.
  return normalizeProjectEventReceiverSettings(result.settings.projectEventReceiver)
}

export function useWebhookHostSettings(
  owner: RuntimeClientTarget,
  localSettings: GlobalSettings,
  updateLocal: (updates: Partial<GlobalSettings>) => Promise<void>
) {
  const [settings, setSettings] = useState<ProjectEventReceiverSettings | null>(null)
  const [status, setStatus] = useState<ForgeInboxStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [revision, setRevision] = useState(0)
  const scope = useRef({ active: true, generation: 0, saving: false }).current
  const local = useRef({ localSettings, updateLocal })
  local.current = { localSettings, updateLocal }
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  const target = useMemo<RuntimeClientTarget>(
    () => (environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }),
    [environmentId]
  )

  useEffect(() => {
    scope.active = true
    return () => {
      scope.active = false
      scope.generation++
    }
  }, [scope])

  useEffect(() => {
    const request = ++scope.generation
    const current = () => scope.active && scope.generation === request
    setLoading(true)
    setError(null)
    setStatusError(null)
    setStatus(null)
    setSettings(null)
    void (async () => {
      const capabilities = environmentId === null ? await ensureLocalRuntimeCapabilities() : null
      if (environmentId === null && capabilities === null) {
        throw new HostSettingsTextError(
          translate(
            'webhook.settings.probeFailed',
            'Could not check this host’s Webhook support. Retry to check again.'
          )
        )
      }
      const supported =
        environmentId === null
          ? capabilities?.includes(PROJECT_EVENT_RECEIVER_RUNTIME_CAPABILITY) === true
          : await runtimeEnvironmentSupportsCapability(
              environmentId,
              PROJECT_EVENT_RECEIVER_RUNTIME_CAPABILITY,
              15_000
            )
      if (!supported) {
        throw new HostSettingsTextError(
          translate(
            'webhook.settings.unsupported',
            'This host does not support Webhook settings. Update the host and retry.'
          )
        )
      }
      if (!current()) {
        return
      }
      const next =
        environmentId === null
          ? normalizeProjectEventReceiverSettings(local.current.localSettings.projectEventReceiver)
          : readReceiver(
              await callRuntimeRpc<{ settings: Partial<GlobalSettings> }>(
                target,
                'settings.get',
                undefined,
                { timeoutMs: 15_000 }
              )
            )
      if (!current()) {
        return
      }
      setSettings(next)
      let ownerStatus: ForgeInboxStatus
      try {
        ownerStatus =
          revision === 0
            ? await readForgeInboxStatus(target)
            : await retryForgeInboxReceiver(target)
      } catch (failure) {
        if (current()) {
          setStatusError(failureText(failure))
        }
        return
      }
      if (current()) {
        setStatus(ownerStatus)
        setStatusError(null)
      }
    })()
      .catch((failure: unknown) => {
        if (current()) {
          setError(failureText(failure))
        }
      })
      .finally(() => {
        if (current()) {
          setLoading(false)
        }
      })
    return () => {
      scope.generation++
    }
  }, [environmentId, revision, scope, target])

  const save = async (draft: ProjectEventReceiverSettings): Promise<boolean> => {
    if (!scope.active || !settings || loading || scope.saving) {
      return false
    }
    const request = scope.generation
    const current = () => scope.active && scope.generation === request
    scope.saving = true
    setSaving(true)
    setError(null)
    try {
      const parsed = parseProjectEventReceiverSettings(draft)
      const next =
        environmentId === null
          ? await local.current.updateLocal({ projectEventReceiver: parsed }).then(() => parsed)
          : readReceiver(
              await callRuntimeRpc<{ settings: Partial<GlobalSettings> }>(
                target,
                'settings.update',
                { projectEventReceiver: parsed },
                { timeoutMs: 15_000 }
              )
            )
      if (!current()) {
        return false
      }
      setSettings(next)
      setStatusError(null)
      let nextStatus: ForgeInboxStatus
      try {
        nextStatus = await retryForgeInboxReceiver(target)
      } catch (failure) {
        if (!current()) {
          return false
        }
        // Why not fail the save: the write is committed; only the listener status is unknown.
        setStatusError(failureText(failure))
        return true
      }
      if (!current()) {
        return false
      }
      setStatus(nextStatus)
      return true
    } catch (failure) {
      if (current()) {
        setError(failureText(failure))
      }
      return false
    } finally {
      scope.saving = false
      if (current()) {
        setSaving(false)
      }
    }
  }
  return {
    settings,
    status,
    error,
    statusError,
    loading,
    saving,
    save,
    refresh: () => setRevision((value) => value + 1)
  }
}

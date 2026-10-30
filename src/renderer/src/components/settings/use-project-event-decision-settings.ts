import { useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { readForgeInboxStatus } from '@/runtime/forge-inbox-client'
import {
  callProjectEventDecisionSettings,
  testProjectEventDecisionConnection
} from '@/runtime/project-event-decision-settings-client'
import {
  loadStateWithoutCapability,
  statusOwnerHostId,
  type OwnerScopeLoadState
} from './project-event-owner-scope'
import type {
  ProjectEventDecisionProbeResult,
  ProjectEventDecisionProvider
} from '../../../../shared/project-event-decision'
import {
  decisionBaseUrl,
  PROJECT_EVENT_DECISION_SETTINGS_CAPABILITY,
  type ProjectEventDecisionManagementView,
  type ProjectEventDecisionSettings
} from '../../../../shared/project-event-decision-settings'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** Client-authored text is safe to show; host errors may carry internal values and must not be. */
class DecisionSettingsTextError extends Error {}

function failureText(failure: unknown): string {
  return failure instanceof DecisionSettingsTextError
    ? failure.message
    : translate(
        'projectEventDecision.error.hostUnavailable',
        'Could not complete the request. Retry; if it keeps failing, check the connection to the host.'
      )
}

export type ProjectEventDecisionLoadState = OwnerScopeLoadState

/** Host-owned decision model settings; every call is qualified by the owner id from host status. */
export function useProjectEventDecisionSettings(owner: RuntimeClientTarget) {
  const [view, setView] = useState<ProjectEventDecisionManagementView | null>(null)
  const [loadState, setLoadState] = useState<ProjectEventDecisionLoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [keySaving, setKeySaving] = useState(false)
  const [probe, setProbe] = useState<{
    running: boolean
    result: ProjectEventDecisionProbeResult | null
  }>({ running: false, result: null })
  const [revision, setRevision] = useState(0)
  const scope = useRef({ active: true, generation: 0, busy: false }).current
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
    setLoadState('loading')
    setError(null)
    setView(null)
    setProbe({ running: false, result: null })
    void (async () => {
      const capabilities = environmentId === null ? await ensureLocalRuntimeCapabilities() : null
      if (environmentId === null && capabilities === null) {
        throw new DecisionSettingsTextError(
          translate(
            'projectEventDecision.error.probeFailed',
            'Could not check whether this host supports event decision settings. Retry to check again.'
          )
        )
      }
      const supported =
        environmentId === null
          ? capabilities?.includes(PROJECT_EVENT_DECISION_SETTINGS_CAPABILITY) === true
          : await runtimeEnvironmentSupportsCapability(
              environmentId,
              PROJECT_EVENT_DECISION_SETTINGS_CAPABILITY,
              15_000
            )
      if (!current()) {
        return
      }
      if (!supported) {
        const state = await loadStateWithoutCapability(target)
        if (current()) {
          setLoadState(state)
        }
        return
      }
      const ownerHostId = statusOwnerHostId(await readForgeInboxStatus(target))
      if (!current()) {
        return
      }
      if (ownerHostId === null) {
        setLoadState('unattached')
        return
      }
      const next = await callProjectEventDecisionSettings(target, 'getSettings', { ownerHostId })
      if (!current()) {
        return
      }
      setView(next)
      setLoadState('ready')
    })().catch((failure: unknown) => {
      if (current()) {
        setError(failureText(failure))
        setLoadState('ready')
      }
    })
    return () => {
      scope.generation++
    }
  }, [environmentId, revision, scope, target])

  const mutate = async (
    apply: (ownerHostId: string) => Promise<ProjectEventDecisionManagementView>
  ): Promise<boolean> => {
    if (!scope.active || scope.busy || view === null) {
      return false
    }
    const request = scope.generation
    const current = () => scope.active && scope.generation === request
    scope.busy = true
    setError(null)
    try {
      const next = await apply(view.ownerHostId)
      if (!current()) {
        return false
      }
      setView(next)
      setProbe({ running: false, result: null })
      return true
    } catch (failure) {
      if (current()) {
        setError(failureText(failure))
      }
      return false
    } finally {
      scope.busy = false
    }
  }

  const saveSettings = async (settings: ProjectEventDecisionSettings): Promise<boolean> => {
    setSaving(true)
    try {
      return await mutate((ownerHostId) =>
        callProjectEventDecisionSettings(target, 'saveSettings', { ownerHostId, settings })
      )
    } finally {
      if (scope.active) {
        setSaving(false)
      }
    }
  }

  const saveApiKey = async (
    provider: ProjectEventDecisionProvider,
    apiKey: string
  ): Promise<boolean> => {
    setKeySaving(true)
    try {
      return await mutate((ownerHostId) =>
        callProjectEventDecisionSettings(target, 'saveApiKey', { ownerHostId, provider, apiKey })
      )
    } finally {
      if (scope.active) {
        setKeySaving(false)
      }
    }
  }

  const clearApiKey = async (provider: ProjectEventDecisionProvider): Promise<boolean> => {
    setKeySaving(true)
    try {
      return await mutate((ownerHostId) =>
        callProjectEventDecisionSettings(target, 'clearApiKey', { ownerHostId, provider })
      )
    } finally {
      if (scope.active) {
        setKeySaving(false)
      }
    }
  }

  const testConnection = async (): Promise<void> => {
    // Why share the busy flag: a probe racing a save could report settings that are being replaced.
    if (!scope.active || scope.busy || view === null) {
      return
    }
    const request = scope.generation
    const current = () => scope.active && scope.generation === request
    scope.busy = true
    setProbe({ running: true, result: null })
    setError(null)
    try {
      const result = await testProjectEventDecisionConnection(target, {
        ownerHostId: view.ownerHostId
      })
      if (current()) {
        setProbe({ running: false, result })
      }
    } catch (failure) {
      if (current()) {
        setProbe({ running: false, result: null })
        setError(failureText(failure))
      }
    } finally {
      scope.busy = false
    }
  }

  return {
    view,
    ready:
      loadState === 'ready' &&
      view !== null &&
      (view.settings.provider === 'jev'
        ? view.settings.apiKeysSaved.jev
        : view.settings.baseUrl !== '' && decisionBaseUrl(view.settings.baseUrl) !== null),
    loadState,
    loading: loadState === 'loading',
    error,
    saving,
    keySaving,
    probe,
    saveSettings,
    saveApiKey,
    clearApiKey,
    testConnection,
    refresh: () => setRevision((value) => value + 1)
  }
}

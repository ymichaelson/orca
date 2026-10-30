import { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { readForgeInboxStatus } from '@/runtime/forge-inbox-client'
import {
  readProjectEventActivity,
  readProjectEventPolicy,
  updateProjectEventPolicy
} from '@/runtime/project-event-client'
import { MAX_RULES_BYTES } from '../../../../shared/forge-inbox-config'
import type { ProjectEventActivityView } from '../../../../shared/forge-inbox-project-event-activity'
import type { ProjectEventBindingView } from '../../../../shared/forge-inbox-project-binding'
import type { ProjectEventPolicyView } from '../../../../shared/forge-inbox-project-event-policy'
import { FORGE_INBOX_PROJECT_EVENT_AGENT_RUNTIME_CAPABILITY } from '../../../../shared/forge-inbox-runtime-capabilities'
import { DEFAULT_PROJECT_EVENT_RULES } from '../../../../shared/project-event-default-rules'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  loadStateWithoutCapability,
  statusOwnerHostId,
  type OwnerScopeLoadState
} from './project-event-owner-scope'

/** The four settings this section edits; everything else in the policy is left to the owner. */
export type ProjectEventAgentDraft = {
  enabled: boolean
  agentId: string | null
  model: string
  rules: string
}

export type ProjectEventAgentLoadState = OwnerScopeLoadState

function draftFromPolicy(policy: ProjectEventPolicyView | null): ProjectEventAgentDraft {
  return policy === null
    ? { enabled: false, agentId: null, model: '', rules: DEFAULT_PROJECT_EVENT_RULES }
    : {
        enabled: policy.enabled,
        agentId: policy.agentId,
        model: policy.model ?? '',
        rules: policy.rules
      }
}

/** Rules are stored as UTF-8 bytes, so the limit is counted the same way the owner counts it. */
function rulesByteLength(rules: string): number {
  return new TextEncoder().encode(rules).length
}

/** The repo's project event policy as the owner host has it, edited with a compare-and-set write. */
export function useProjectEventAgentSettings(input: {
  repoId: string
  target: RuntimeClientTarget
}) {
  const { repoId, target } = input
  const [policy, setPolicy] = useState<ProjectEventPolicyView | null>(null)
  const [ownerHostId, setOwnerHostId] = useState<string | null>(null)
  // Why a ref: a write made right after another save must use the generation that save returned.
  const generation = useRef(0)
  const [draft, setDraft] = useState<ProjectEventAgentDraft>(() => draftFromPolicy(null))
  const [loadState, setLoadState] = useState<ProjectEventAgentLoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [mergeNotice, setMergeNotice] = useState(false)
  const [binding, setBinding] = useState<ProjectEventBindingView | null>(null)
  const [activity, setActivity] = useState<ProjectEventActivityView | null>(null)
  const [saving, setSaving] = useState(false)
  const [revision, setRevision] = useState(0)
  const scope = useRef({ active: true, generation: 0, busy: false }).current
  const environmentId = target.kind === 'environment' ? target.environmentId : null

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
    setMergeNotice(false)
    void (async () => {
      const capabilities = environmentId === null ? await ensureLocalRuntimeCapabilities() : null
      if (!current()) {
        return
      }
      const supported =
        environmentId === null
          ? capabilities?.includes(FORGE_INBOX_PROJECT_EVENT_AGENT_RUNTIME_CAPABILITY) === true
          : await runtimeEnvironmentSupportsCapability(
              environmentId,
              FORGE_INBOX_PROJECT_EVENT_AGENT_RUNTIME_CAPABILITY,
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
      const owner = statusOwnerHostId(await readForgeInboxStatus(target))
      if (!current()) {
        return
      }
      if (owner === null) {
        setLoadState('unattached')
        return
      }
      const view = await readProjectEventPolicy(owner, repoId, target)
      if (!current()) {
        return
      }
      setOwnerHostId(owner)
      setPolicy(view.policy)
      setBinding(view.binding)
      generation.current = view.policy?.generation ?? 0
      setDraft(draftFromPolicy(view.policy))
      setLoadState('ready')
    })().catch(() => {
      if (current()) {
        // Why: host error messages can carry internal values, so only this client's copy is shown.
        setError(
          translate(
            'projectEventAgent.error.hostUnavailable',
            'Could not read the project event settings. Retry; if it keeps failing, check the connection to the host.'
          )
        )
        setLoadState('ready')
      }
    })
    return () => {
      scope.generation++
    }
  }, [environmentId, repoId, revision, scope, target])

  useEffect(() => {
    if (ownerHostId === null || loadState !== 'ready') {
      return
    }
    let cancelled = false
    void readProjectEventActivity(ownerHostId, repoId, target)
      .then((view) => {
        if (!cancelled) {
          setActivity(view)
        }
      })
      .catch(() => {
        // Why: activity is auxiliary, so a failed read must not hide the policy editor.
        if (!cancelled) {
          setActivity(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [loadState, ownerHostId, repoId, revision, target])

  /** Re-reads what the host has after a retry or rotation, leaving unsaved draft edits alone. */
  const refreshStatus = async (): Promise<void> => {
    if (ownerHostId === null) {
      return
    }
    // Why the generation: the user may switch projects while this read is in flight.
    const request = scope.generation
    const current = () => scope.active && scope.generation === request
    const view = await readProjectEventPolicy(ownerHostId, repoId, target)
    if (!current()) {
      return
    }
    setBinding(view.binding)
    const activityView = await readProjectEventActivity(ownerHostId, repoId, target)
    if (current()) {
      setActivity(activityView)
    }
  }

  const update = (patch: Partial<ProjectEventAgentDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
    setMergeNotice(false)
  }

  const rulesBytes = rulesByteLength(draft.rules)
  const rulesRejected = rulesBytes > MAX_RULES_BYTES || draft.rules.includes('\u0000')
  const validAgent = (value: string | null): boolean =>
    value !== null && getAgentCatalog().some((entry) => entry.id === value)
  const validDraft = (candidate: ProjectEventAgentDraft): boolean =>
    rulesByteLength(candidate.rules) <= MAX_RULES_BYTES &&
    !candidate.rules.includes('\u0000') &&
    (!candidate.enabled || validAgent(candidate.agentId)) &&
    (policy?.automaticAnalysis !== true ||
      (candidate.agentId !== null && candidate.agentId !== '' && candidate.model.trim() !== ''))
  const needsAgentToEnable = !validAgent(draft.agentId)
  const needsAgent = draft.enabled && needsAgentToEnable
  const needsAgentAndModel =
    policy?.automaticAnalysis === true &&
    (draft.agentId === null || draft.agentId === '' || draft.model.trim() === '')
  const writable = loadState === 'ready' && ownerHostId !== null && !saving
  const canSave = writable && validDraft(draft)
  const canEnable = writable && validDraft({ ...draft, enabled: true })

  /** Saves the four editable fields, with `overrides` winning over the draft. A stale generation keeps the draft and asks for a second save. */
  const save = async (overrides: Partial<ProjectEventAgentDraft> = {}): Promise<boolean> => {
    const effective = { ...draft, ...overrides }
    if (
      !scope.active ||
      scope.busy ||
      !writable ||
      !validDraft(effective) ||
      ownerHostId === null
    ) {
      return false
    }
    const request = scope.generation
    const current = () => scope.active && scope.generation === request
    scope.busy = true
    setSaving(true)
    setError(null)
    try {
      const result = await updateProjectEventPolicy(
        ownerHostId,
        repoId,
        generation.current,
        {
          enabled: effective.enabled,
          agentId: effective.agentId,
          model: effective.model.trim() === '' ? null : effective.model.trim(),
          rules: effective.rules
        },
        target
      )
      if (!current()) {
        return false
      }
      if (result.ok) {
        setPolicy(result.policy)
        generation.current = result.generation
        setMergeNotice(false)
        setDraft((latest) => ({ ...latest, ...overrides }))
        return true
      }
      if (result.reason === 'stale-generation') {
        generation.current = result.generation
        setMergeNotice(true)
        // Why: the current policy may now say automaticAnalysis is on, which forbids an empty model.
        const refreshed = await readProjectEventPolicy(ownerHostId, repoId, target)
        if (current()) {
          setPolicy(refreshed.policy)
        }
        return false
      }
      setError(
        translate(
          'projectEventAgent.error.invalidPolicy',
          'The host rejected these settings. Check the agent, model and rules, then save again.'
        )
      )
      return false
    } catch {
      if (current()) {
        setError(
          translate(
            'projectEventAgent.error.saveFailed',
            'Could not save the project event settings. Retry; your edits are still here.'
          )
        )
      }
      return false
    } finally {
      scope.busy = false
      if (scope.active) {
        setSaving(false)
      }
    }
  }

  return {
    loadState,
    policy,
    draft,
    update,
    save,
    saving,
    error,
    mergeNotice,
    ownerHostId,
    binding,
    activity,
    refreshStatus,
    rulesBytes,
    rulesRejected,
    needsAgentAndModel,
    needsAgent,
    needsAgentToEnable,
    canEnable,
    canSave,
    reload: () => setRevision((value) => value + 1)
  }
}

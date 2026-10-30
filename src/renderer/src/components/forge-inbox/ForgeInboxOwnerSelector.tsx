import { useEffect, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import { FORGE_INBOX_RUNTIME_CAPABILITY } from '../../../../shared/forge-inbox-runtime-capabilities'
import {
  isListedRemoteServer,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/runtime-environments'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const LOCAL_VALUE = 'local'
const ENVIRONMENT_VALUE_PREFIX = 'environment:'

type ProbeAnswers = Readonly<Record<string, boolean>>

function useOwnerProbes(environmentIds: readonly string[]): ProbeAnswers {
  const key = environmentIds.join('\n')
  const [answers, setAnswers] = useState<ProbeAnswers>({})
  useEffect(() => {
    let active = true
    for (const environmentId of key === '' ? [] : key.split('\n')) {
      runtimeEnvironmentSupportsCapability(environmentId, FORGE_INBOX_RUNTIME_CAPABILITY)
        .then((supported) => {
          if (active) {
            setAnswers((current) => ({ ...current, [environmentId]: supported }))
          }
        })
        // Why: an unanswered probe is "checking", never "unsupported".
        .catch(() => {})
    }
    return () => {
      active = false
    }
  }, [key])
  return answers
}

function ownerLabel(state: 'checking' | 'unavailable', hostName: string): string {
  return state === 'unavailable'
    ? translate(
        'auto.components.forge-inbox.ForgeInboxOwnerSelector.unavailable',
        '{{value0}} (unavailable)',
        { value0: hostName }
      )
    : translate(
        'auto.components.forge-inbox.ForgeInboxOwnerSelector.checking',
        '{{value0}} (checking…)',
        { value0: hostName }
      )
}

/** Every saved remote host stays listed; capability only decides whether it can be chosen. */
export function ForgeInboxOwnerSelector({
  target,
  environments,
  onChange
}: {
  target: RuntimeClientTarget
  environments: readonly PublicKnownRuntimeEnvironment[]
  onChange: (target: RuntimeClientTarget) => void
}): React.JSX.Element {
  const environmentId = runtimeTargetEnvironmentId(target)
  const hosts = environments.filter(isListedRemoteServer)
  // Why: a banner click can land on a host Settings does not list, and the trigger must name it.
  const selected = environments.find((environment) => environment.id === environmentId)
  const options = selected !== undefined && !hosts.includes(selected) ? [...hosts, selected] : hosts
  const answers = useOwnerProbes(options.map((environment) => environment.id))
  const value = environmentId === null ? LOCAL_VALUE : `${ENVIRONMENT_VALUE_PREFIX}${environmentId}`

  return (
    <Select
      value={value}
      onValueChange={(next) =>
        onChange(
          next.startsWith(ENVIRONMENT_VALUE_PREFIX)
            ? {
                kind: 'environment',
                environmentId: next.slice(ENVIRONMENT_VALUE_PREFIX.length)
              }
            : { kind: 'local' }
        )
      }
    >
      <SelectTrigger
        size="sm"
        aria-label={translate(
          'auto.components.forge-inbox.ForgeInboxOwnerSelector.label',
          'Inbox host'
        )}
        className="min-w-36"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={LOCAL_VALUE}>{getLocalExecutionHostLabel()}</SelectItem>
        {options.map((environment) => {
          const supported = answers[environment.id]
          if (supported === undefined) {
            return (
              <SelectItem
                key={environment.id}
                value={`${ENVIRONMENT_VALUE_PREFIX}${environment.id}`}
                disabled
              >
                {ownerLabel('checking', environment.name)}
              </SelectItem>
            )
          }
          return (
            <SelectItem
              key={environment.id}
              value={`${ENVIRONMENT_VALUE_PREFIX}${environment.id}`}
              disabled={!supported}
            >
              {supported ? environment.name : ownerLabel('unavailable', environment.name)}
            </SelectItem>
          )
        })}
        {environmentId !== null && selected === undefined ? (
          // Why: the trigger must name a host this list has never seen without inventing a name.
          <SelectItem value={`${ENVIRONMENT_VALUE_PREFIX}${environmentId}`} disabled>
            {translate(
              'auto.components.settings.SettingsHostScopePicker.unavailable',
              '{{value0}} (unavailable)',
              { value0: environmentId }
            )}
          </SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  )
}

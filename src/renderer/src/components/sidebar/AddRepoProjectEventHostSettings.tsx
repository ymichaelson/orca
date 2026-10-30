import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { ProjectEventDecisionSettingsCard } from '../settings/ProjectEventDecisionSettingsCard'
import { WebhookIntegrationCard } from '../settings/WebhookIntegrationCard'

export function AddRepoProjectEventHostSettings({
  target,
  section,
  onBack,
  onBusyChange
}: {
  target: RuntimeClientTarget
  section: 'decision' | 'receiver'
  onBack: () => void
  onBusyChange: (busy: boolean) => void
}): React.JSX.Element {
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const [busy, setBusy] = useState(false)
  const hostScope = { target, available: true }
  const handleBusy = useCallback(
    (value: boolean): void => {
      setBusy(value)
      onBusyChange(value)
    },
    [onBusyChange]
  )
  return (
    <div className="space-y-3">
      <div className="max-h-[50vh] overflow-y-auto scrollbar-sleek pr-1">
        {section === 'decision' ? (
          <ProjectEventDecisionSettingsCard
            hostScope={hostScope}
            runtimeEnvironments={runtimeEnvironments}
            onBusyChange={handleBusy}
          />
        ) : settings === null ? (
          <p className="text-xs text-muted-foreground">
            {translate('projectEventAgent.loading', 'Loading…')}
          </p>
        ) : (
          <WebhookIntegrationCard
            hostScope={hostScope}
            runtimeEnvironments={runtimeEnvironments}
            settings={settings}
            updateSettings={updateSettings}
            onBusyChange={handleBusy}
          />
        )}
      </div>
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onBack}>
          {translate('projectEventAgent.addProject.backToSetup', 'Back to project setup')}
        </Button>
      </div>
    </div>
  )
}

import type { ForgeInboxErrorSource } from '../../../../shared/forge-inbox-error-source'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { SettingsNavigationTarget } from '@/lib/settings-navigation-types'
import { forgeErrorCodeLabel } from './forge-inbox-error-code-copy'

export type ForgeInboxRepairActions = {
  openProjectSettings?: () => void
  openHostSettings: (target: SettingsNavigationTarget) => void
}

const PROJECT_CONFIG_ERRORS: ReadonlySet<string> = new Set([
  'dispatch-unconfigured',
  'missing-policy',
  'missing-link',
  'policy-disabled',
  'policy-revoked',
  'workspace-unresolved',
  'workspace-remote-unsupported',
  'workspace-ambiguous',
  'workspace-repo-mismatch'
])

function hostRepairTarget(
  code: string,
  source: ForgeInboxErrorSource | undefined
): SettingsNavigationTarget | null {
  const hostScope = { kind: 'local' } as const
  if (code === 'unauthorized' || code === 'network') {
    if (source === 'decision-provider') {
      return { pane: 'agents', repoId: null, hostScope, sectionId: 'agents-event-decision' }
    }
    if (source === 'gitlab') {
      return { pane: 'integrations', repoId: null, hostScope, sectionId: 'integrations-gitlab' }
    }
  }
  if (source === 'gitlab' && ['unauthenticated', 'no-credential', 'forbidden'].includes(code)) {
    return { pane: 'integrations', repoId: null, hostScope, sectionId: 'integrations-gitlab' }
  }
  if (source === 'receiver' && ['receiver-not-configured', 'callback-blocked'].includes(code)) {
    return { pane: 'integrations', repoId: null, hostScope, sectionId: 'integrations-webhook' }
  }
  return null
}

export function ForgeInboxError({
  code,
  source,
  repairActions
}: {
  code: string
  source?: ForgeInboxErrorSource
  repairActions?: ForgeInboxRepairActions
}): React.JSX.Element {
  const projectConfig = PROJECT_CONFIG_ERRORS.has(code)
  const hostTarget = hostRepairTarget(code, source)
  return (
    <>
      <span className="text-2xs text-destructive">{forgeErrorCodeLabel(code, source)}</span>
      {projectConfig ? (
        repairActions?.openProjectSettings ? (
          <Button variant="link" size="xs" onClick={repairActions.openProjectSettings}>
            {translate('projectEventInbox.repair.project', 'Open project event settings')}
          </Button>
        ) : (
          <span className="text-2xs text-muted-foreground">
            {translate(
              'projectEventInbox.repair.projectUnavailable',
              'Project settings are unavailable: this host has not identified a linked Orca project.'
            )}
          </span>
        )
      ) : hostTarget !== null && repairActions ? (
        <Button variant="link" size="xs" onClick={() => repairActions.openHostSettings(hostTarget)}>
          {hostTarget.pane === 'agents'
            ? translate('projectEventInbox.repair.decision', 'Open event decision settings')
            : translate('projectEventInbox.repair.integrations', 'Open Integrations')}
        </Button>
      ) : null}
    </>
  )
}

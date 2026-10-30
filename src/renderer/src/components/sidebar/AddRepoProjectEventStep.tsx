import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { translate } from '@/i18n/i18n'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { retryProjectEvent } from '@/runtime/project-event-client'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { ProjectEventAgentFields } from '../settings/ProjectEventAgentFields'
import { agentDetectionTargetFor } from '../settings/project-event-owner-scope'
import { bindingFailureCopy } from '../settings/project-event-status-copy'
import { useProjectEventAgentSettings } from '../settings/use-project-event-agent-settings'
import { useProjectEventDecisionSettings } from '../settings/use-project-event-decision-settings'
import { AddRepoProjectEventHostSettings } from './AddRepoProjectEventHostSettings'

export type AddRepoProjectEventStepProps = {
  repo: Repo
  /** Null when this app has no route to the repo's owner host. */
  target: RuntimeClientTarget | null
  /** Runs the held add completion once; false when it did not run or failed. */
  onContinue: () => Promise<boolean>
  onBusyChange: (busy: boolean) => void
}

type Connection = { ok: true; project: string } | { ok: false; code: string | null }
type Revert = 'idle' | 'running' | 'done' | 'failed'

/** The host found nothing to bind; that is a neutral answer for this repo, not a failed connection. */
const NOT_GITLAB_CODES: ReadonlySet<string | null> = new Set(['not-gitlab', 'no-git-remote'])

function StepHeader(): React.JSX.Element {
  return (
    <DialogHeader>
      <DialogTitle>{translate('projectEventAgent.title', 'Project event agent')}</DialogTitle>
      <DialogDescription>
        {translate(
          'projectEventAgent.addProject.description',
          'Let this project answer GitLab events with an agent. You can skip this and set it up later in the project settings.'
        )}
      </DialogDescription>
    </DialogHeader>
  )
}

function ProjectAddedLine({ name }: { name: string }): React.JSX.Element {
  return (
    <p className="flex items-center gap-1.5 text-xs">
      <Check className="size-3.5 shrink-0 text-status-success" />
      {translate('projectEventAgent.addProject.projectAdded', 'Project added: {{name}}', { name })}
    </p>
  )
}

export function AddRepoProjectEventStep(props: AddRepoProjectEventStepProps): React.JSX.Element {
  const { repo, target } = props
  return (
    <>
      <StepHeader />
      {target === null ? (
        <UnreachableOwner repo={repo} onContinue={props.onContinue} />
      ) : (
        <ProjectEventSetupBody
          key={`${repo.id}:${JSON.stringify(target)}`}
          {...props}
          target={target}
        />
      )}
    </>
  )
}

function UnreachableOwner({
  repo,
  onContinue
}: {
  repo: Repo
  onContinue: () => Promise<boolean>
}): React.JSX.Element {
  return (
    <div className="space-y-3 pt-1">
      <div className="space-y-1.5 rounded-lg border border-border p-3">
        <ProjectAddedLine name={repo.displayName} />
        <p className="text-xs text-muted-foreground">
          {translate(
            'projectEventAgent.unroutable',
            'This project belongs to a host this app cannot reach directly, so its project event settings cannot be edited here.'
          )}
        </p>
      </div>
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={() => void onContinue()}>
          {translate('projectEventAgent.addProject.continue', 'Continue')}
        </Button>
      </div>
    </div>
  )
}

function ProjectEventSetupBody({
  repo,
  target,
  onContinue,
  onBusyChange
}: AddRepoProjectEventStepProps & { target: RuntimeClientTarget }): React.JSX.Element {
  const repoId = repo.id
  const settings = useProjectEventAgentSettings({ repoId, target })
  const decision = useProjectEventDecisionSettings(target)
  const [hostSettings, setHostSettings] = useState<'decision' | 'receiver' | null>(null)
  const [hostSettingsBusy, setHostSettingsBusy] = useState(false)
  const detection = useDetectedAgents(agentDetectionTargetFor(target))
  const [connecting, setConnecting] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [connection, setConnection] = useState<Connection | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [savedKey, setSavedKey] = useState<string | null>(null)
  const [revert, setRevert] = useState<Revert>('idle')
  const policySaved = savedKey === JSON.stringify({ ...settings.draft, enabled: true })
  const busy =
    settings.saving || connecting || finishing || revert === 'running' || hostSettingsBusy
  const connected = connection?.ok === true
  const notGitlab = connection?.ok === false && NOT_GITLAB_CODES.has(connection.code)
  const settled = connected || notGitlab
  const attemptFailed = saveFailed || (connection?.ok === false && !notGitlab)

  useEffect(() => {
    onBusyChange(busy)
  }, [busy, onBusyChange])
  useEffect(() => () => onBusyChange(false), [onBusyChange])

  const connect = async (): Promise<Connection | null> => {
    if (settings.ownerHostId === null) {
      return null
    }
    setConnecting(true)
    try {
      const outcome = await retryProjectEvent(settings.ownerHostId, repoId, target)
      return outcome.ok
        ? { ok: true, project: `${outcome.binding.gitlabHost}/${outcome.binding.gitlabPath}` }
        : { ok: false, code: outcome.code ?? null }
    } catch {
      return { ok: false, code: null }
    } finally {
      setConnecting(false)
    }
  }

  /** The policy is saved once per draft; a retry after a webhook failure only re-runs the connection. */
  const enable = async (): Promise<void> => {
    if (!decision.ready || !settings.canEnable || busy) {
      return
    }
    setConnection(null)
    setSaveFailed(false)
    if (!policySaved) {
      const key = JSON.stringify({ ...settings.draft, enabled: true })
      if (!(await settings.save({ enabled: true }))) {
        setSaveFailed(true)
        return
      }
      setSavedKey(key)
    }
    const result = await connect()
    if (result?.ok === false && NOT_GITLAB_CODES.has(result.code)) {
      // Why: an enabled policy that can never connect is misleading, so the CAS write undoes it.
      setRevert('running')
      setRevert((await settings.save({ enabled: false })) ? 'done' : 'failed')
    }
    setConnection(result)
  }

  const finishThen = async (run: () => Promise<boolean>): Promise<void> => {
    setFinishing(true)
    try {
      await run()
    } finally {
      setFinishing(false)
    }
  }

  const canEnable = !busy && decision.ready && settings.canEnable
  const receiverMissing = connection?.ok === false && connection.code === 'receiver-not-configured'

  if (hostSettings !== null) {
    return (
      <AddRepoProjectEventHostSettings
        target={target}
        section={hostSettings}
        onBusyChange={setHostSettingsBusy}
        onBack={() => {
          setHostSettings(null)
          decision.refresh()
        }}
      />
    )
  }

  return (
    <div className="space-y-3 pt-1">
      <div role="status" className="space-y-1.5 rounded-lg border border-border p-3">
        <ProjectAddedLine name={repo.displayName} />
        {connecting ? (
          <p className="text-xs text-muted-foreground">
            {translate('projectEventAgent.addProject.connecting', 'Connecting to GitLab…')}
          </p>
        ) : null}
        {connection?.ok === true ? (
          <p className="text-xs text-status-success">
            {translate(
              'projectEventAgent.addProject.connected',
              'Event agent connected to GitLab project {{project}}.',
              { project: connection.project }
            )}
          </p>
        ) : null}
        {notGitlab && revert === 'done' ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'projectEventAgent.addProject.notGitlab',
              'This repository has no GitLab project to connect, so the event agent was left off. The project was added normally.'
            )}
          </p>
        ) : null}
        {notGitlab && revert === 'failed' ? (
          <p className="text-xs text-destructive">
            {translate(
              'projectEventAgent.addProject.notGitlabStillOn',
              'This repository has no GitLab project to connect, but the event agent could not be switched back off. Turn it off in the project settings.'
            )}
          </p>
        ) : null}
        {connection?.ok === false && !notGitlab ? (
          <p className="text-xs text-destructive">
            {translate(
              'projectEventAgent.addProject.notConnected',
              'Event agent settings are saved, but the GitLab webhook is not connected: {{reason}}',
              { reason: bindingFailureCopy(connection.code ?? 'unknown-outcome') }
            )}
          </p>
        ) : null}
        {saveFailed ? (
          <p className="text-xs text-destructive">
            {translate(
              'projectEventAgent.addProject.notSaved',
              'Event agent settings were not saved. Your entries are kept.'
            )}
          </p>
        ) : null}
        {receiverMissing ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'projectEventAgent.addProject.receiverHelp',
              'Set up the receiver on this host, then return to retry. Your project settings are kept.'
            )}
          </p>
        ) : null}
      </div>
      {settings.loadState === 'loading' ? (
        <p className="text-xs text-muted-foreground">
          {translate('projectEventAgent.loading', 'Loading…')}
        </p>
      ) : null}
      {settings.loadState === 'unsupported' ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'projectEventAgent.unsupported',
            'This host runs an older Orca build that does not support project event agents. Update the host to edit these settings.'
          )}
        </p>
      ) : null}
      {settings.loadState === 'unattached' ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'projectEventAgent.unattached',
            'The inbox service is not running on this host, so project event settings are unavailable.'
          )}
        </p>
      ) : null}
      {settings.loadState === 'ready' && settings.ownerHostId !== null ? (
        <div className="max-h-[50vh] space-y-4 overflow-y-auto scrollbar-sleek pr-1">
          <ProjectEventAgentFields
            idPrefix="add-repo-project-event"
            repoId={repoId}
            target={target}
            draft={settings.draft}
            onChange={settings.update}
            agents={getAgentCatalog()}
            detectedIds={detection.detectedIds}
            rulesBytes={settings.rulesBytes}
            rulesRejected={settings.rulesRejected}
            showEnabled={false}
            disabled={busy || settled}
          />
          {settings.needsAgentToEnable ? (
            <p role="status" className="text-xs text-muted-foreground">
              {translate(
                'projectEventAgent.needAgent',
                'Choose an existing agent before enabling project events.'
              )}
            </p>
          ) : null}
          {settings.needsAgentAndModel ? (
            <p role="alert" className="text-xs text-destructive">
              {translate(
                'projectEventAgent.needAgentAndModel',
                'Automatic analysis is on for this project, so choose an agent and a model before saving.'
              )}
            </p>
          ) : null}
          {settings.mergeNotice ? (
            <p role="status" className="text-xs text-muted-foreground">
              {translate(
                'projectEventAgent.merged',
                'Another window changed these settings. Your edits were kept; save again to confirm them.'
              )}
            </p>
          ) : null}
        </div>
      ) : null}
      {!decision.ready ? (
        <p role="status" className="text-xs text-muted-foreground">
          {decision.loading
            ? translate('projectEventDecision.status.loading', 'Loading…')
            : (decision.error ??
              translate(
                'projectEventAgent.addProject.decisionRequired',
                'The event decision model is not ready on this host. Open its settings to complete setup or check host availability. Your project entries are kept.'
              ))}
        </p>
      ) : null}
      {settings.error ? (
        <p role="alert" className="text-xs text-destructive">
          {settings.error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {!decision.ready ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || decision.loading}
            onClick={() => setHostSettings('decision')}
          >
            {translate('projectEventAgent.addProject.setupDecision', 'Set up decision model')}
          </Button>
        ) : null}
        {receiverMissing ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setHostSettings('receiver')}
          >
            {translate(
              'projectEventAgent.addProject.openIntegrations',
              'Open Integrations settings'
            )}
          </Button>
        ) : null}
        {settings.loadState === 'ready' && settings.ownerHostId === null ? (
          <Button type="button" size="sm" variant="outline" onClick={settings.reload}>
            {translate('projectEventAgent.addProject.reload', 'Reload')}
          </Button>
        ) : null}
        {settled || settings.loadState !== 'ready' || settings.ownerHostId === null ? (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void finishThen(onContinue)}
          >
            {translate('projectEventAgent.addProject.continue', 'Continue')}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void finishThen(onContinue)}
            >
              {attemptFailed
                ? translate('projectEventAgent.addProject.continueWithout', 'Continue without it')
                : translate('projectEventAgent.addProject.skip', 'Skip for now')}
            </Button>
            <Button type="button" size="sm" disabled={!canEnable} onClick={() => void enable()}>
              {attemptFailed
                ? translate('projectEventAgent.addProject.retry', 'Retry')
                : translate('projectEventAgent.enabled', 'Enable project event agent')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

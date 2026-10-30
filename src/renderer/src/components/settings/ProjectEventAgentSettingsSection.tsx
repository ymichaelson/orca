import type { Repo } from '../../../../shared/repo-types'
import { retryProjectEvent } from '@/runtime/project-event-client'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { Button } from '../ui/button'
import { ProjectEventAgentFields } from './ProjectEventAgentFields'
import { agentDetectionTargetFor, projectEventOwnerTarget } from './project-event-owner-scope'
import { ProjectEventBindingPanel } from './ProjectEventBindingPanel'
import {
  ProjectEventGitlabProjectSection,
  type ProjectEventGitlabProjectApplyResult
} from './ProjectEventGitlabProjectSection'
import { SearchableSetting } from './SearchableSetting'
import { useProjectEventAgentSettings } from './use-project-event-agent-settings'

function titleText(): string {
  return translate('projectEventAgent.title', 'Project event agent')
}

function descriptionText(): string {
  return translate(
    'projectEventAgent.description',
    'Let this project answer GitLab events with an agent: review requests, participating merge requests, pipeline failures, issue mentions and assignments.'
  )
}

export function ProjectEventAgentSettingsSection({
  repo,
  updateRepo,
  forceVisible
}: {
  repo: Repo
  updateRepo: (id: string, updates: { projectEventGitlabProject: string | null }) => unknown
  forceVisible?: boolean
}): React.JSX.Element {
  const target = projectEventOwnerTarget(repo)
  if (target === null) {
    return (
      <SearchableSetting
        title={titleText()}
        description={descriptionText()}
        keywords={['agent', 'project event', 'webhook', repo.displayName]}
        forceVisible={forceVisible}
        className="space-y-2"
      >
        <p className="text-sm font-semibold">{titleText()}</p>
        <p className="text-xs text-muted-foreground">
          {translate(
            'projectEventAgent.unroutable',
            'This project belongs to a host this app cannot reach directly, so its project event settings cannot be edited here.'
          )}
        </p>
      </SearchableSetting>
    )
  }
  return (
    <ProjectEventAgentSettingsBody
      repo={repo}
      target={target}
      updateRepo={updateRepo}
      forceVisible={forceVisible}
    />
  )
}

function ProjectEventAgentSettingsBody({
  repo,
  target,
  updateRepo,
  forceVisible
}: {
  repo: Repo
  target: RuntimeClientTarget
  updateRepo: (id: string, updates: { projectEventGitlabProject: string | null }) => unknown
  forceVisible?: boolean
}): React.JSX.Element {
  const repoId = repo.id
  const repoLabel = repo.displayName
  const settings = useProjectEventAgentSettings({ repoId, target })
  const detection = useDetectedAgents(agentDetectionTargetFor(target))
  const agents = getAgentCatalog()

  /** Saving only stores the text; the host is the one that parses it and re-runs the binding. */
  const applyGitlabProject = async (
    project: string | null
  ): Promise<ProjectEventGitlabProjectApplyResult> => {
    const saved = await updateRepo(repoId, { projectEventGitlabProject: project })
    if (saved === false) {
      return { saved: false, code: null }
    }
    if (settings.ownerHostId === null) {
      return { saved: true, code: null }
    }
    const outcome = await retryProjectEvent(settings.ownerHostId, repoId, target).catch(() => null)
    await settings.refreshStatus().catch(() => {})
    return {
      saved: true,
      code: outcome === null ? 'unknown-outcome' : outcome.ok ? null : (outcome.code ?? null)
    }
  }

  return (
    <SearchableSetting
      title={titleText()}
      description={descriptionText()}
      keywords={['agent', 'project event', 'webhook', 'rules', 'model', repoLabel]}
      forceVisible={forceVisible}
      className="space-y-3"
    >
      <p className="text-sm font-semibold">{titleText()}</p>
      <p className="text-xs text-muted-foreground">{descriptionText()}</p>
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
      {settings.loadState === 'ready' ? (
        <div className="space-y-4">
          <ProjectEventAgentFields
            repoId={repoId}
            target={target}
            draft={settings.draft}
            onChange={settings.update}
            agents={agents}
            detectedIds={detection.detectedIds}
            rulesBytes={settings.rulesBytes}
            rulesRejected={settings.rulesRejected}
            showEnabled
          />
          {settings.needsAgent ? (
            <p role="alert" className="text-xs text-destructive">
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
          {settings.error ? (
            <p role="alert" className="text-xs text-destructive">
              {settings.error}
            </p>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={!settings.canSave}
            onClick={() => void settings.save()}
          >
            {translate('projectEventAgent.save', 'Save project event settings')}
          </Button>
          {repo.kind === 'folder' ? (
            <ProjectEventGitlabProjectSection
              repo={repo}
              forceVisible={forceVisible}
              onApply={applyGitlabProject}
            />
          ) : null}
          <ProjectEventBindingPanel
            ownerHostId={settings.ownerHostId}
            repoId={repoId}
            target={target}
            binding={settings.binding}
            activity={settings.activity}
            saving={settings.saving}
            refreshStatus={settings.refreshStatus}
          />
        </div>
      ) : null}
    </SearchableSetting>
  )
}

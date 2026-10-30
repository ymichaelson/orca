import { useState } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { bindingFailureCopy } from './project-event-status-copy'
import { SearchableSetting } from './SearchableSetting'

/** `saved` is the repo write; `code` is the binding result, which is null when it is not a failure. */
export type ProjectEventGitlabProjectApplyResult = { saved: boolean; code: string | null }

/**
 * Only a folder workspace needs this: a git workspace names its project through its remote,
 * and the execution host still parses and verifies whatever text is saved here.
 */
export function ProjectEventGitlabProjectSection({
  repo,
  forceVisible,
  onApply
}: {
  repo: Repo
  forceVisible?: boolean
  /** Saves the text, re-runs the binding, and re-reads what the host resolved. */
  onApply: (project: string | null) => Promise<ProjectEventGitlabProjectApplyResult>
}): React.JSX.Element {
  const [text, setText] = useState(repo.projectEventGitlabProject ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = text.trim()
  const nextValue = trimmed === '' ? null : trimmed
  const unchanged = nextValue === (repo.projectEventGitlabProject ?? null)
  const label = translate('projectEventAgent.gitlabProject.title', 'GitLab project')

  const apply = async (value: string | null): Promise<void> => {
    if (saving) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      const result = await onApply(value)
      if (!result.saved) {
        throw new Error(
          translate(
            'projectEventAgent.gitlabProject.saveFailed',
            'Could not save the GitLab project for this folder.'
          )
        )
      }
      setText(value ?? '')
      if (result.code !== null) {
        setError(bindingFailureCopy(result.code))
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SearchableSetting
      title={label}
      description={translate(
        'projectEventAgent.gitlabProject.description',
        'Point this folder at a GitLab project so its events can reach the agent. The host verifies the address before registering anything.'
      )}
      keywords={['gitlab', 'project', 'webhook', repo.displayName]}
      forceVisible={forceVisible}
      className="space-y-2"
    >
      <p className="text-sm font-semibold">{label}</p>
      <div className="space-y-2">
        <Label htmlFor={`project-event-gitlab-project-${repo.id}`}>{label}</Label>
        <Input
          id={`project-event-gitlab-project-${repo.id}`}
          value={text}
          spellCheck={false}
          disabled={saving}
          placeholder={translate(
            'projectEventAgent.gitlabProject.placeholder',
            'Paste a GitLab project URL or group/project'
          )}
          onChange={(event) => setText(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {translate(
            'projectEventAgent.gitlabProject.help',
            'Clearing this field removes the local association; a webhook already registered in GitLab must be removed there separately.'
          )}
        </p>
        <Button
          type="button"
          size="sm"
          disabled={saving || unchanged}
          onClick={() => void apply(nextValue)}
        >
          {saving
            ? translate('projectEventAgent.gitlabProject.saving', 'Saving…')
            : translate('projectEventAgent.gitlabProject.save', 'Save GitLab project')}
        </Button>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </SearchableSetting>
  )
}

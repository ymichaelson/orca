import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type {
  ForgeCredentialKind,
  ForgeCredentialStatus,
  ForgeInboxConfig
} from '../../../../shared/forge-inbox-config'
import type { ForgeInboxCredentialWriteOutcome } from '../../../../shared/forge-inbox-rpc-types'
import type { Repo } from '../../../../shared/repo-types'
import { ForgeInboxCredentialEditor } from './ForgeInboxCredentialEditor'
import { ForgeInboxProjectPolicyEditor } from './ForgeInboxProjectPolicyEditor'
import {
  formatForgeUsernames,
  forgeNewProjectPolicy,
  parseForgeUsernames
} from './forge-inbox-settings-draft'

type InstanceConfig = ForgeInboxConfig['instances'][number]
type ProjectPolicy = InstanceConfig['projects'][number]

const PROJECT_ID = /^[1-9][0-9]{0,15}$/

export function ForgeInboxInstanceEditor({
  instance,
  webhookUrl,
  repos,
  credentials,
  onChange,
  onRemove,
  onSetCredential,
  onClearCredential
}: {
  instance: InstanceConfig
  webhookUrl: string
  repos: Repo[]
  credentials: ForgeCredentialStatus[]
  onChange: (next: InstanceConfig) => void
  onRemove: () => void
  onSetCredential: (
    kind: ForgeCredentialKind,
    secret: string,
    allowUnprotectedStorage: boolean
  ) => Promise<ForgeInboxCredentialWriteOutcome>
  onClearCredential: (kind: ForgeCredentialKind) => Promise<ForgeInboxCredentialWriteOutcome>
}): React.JSX.Element {
  const [usernamesText, setUsernamesText] = useState(formatForgeUsernames(instance.usernames))
  const [projectId, setProjectId] = useState('')
  const [repoId, setRepoId] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')

  const update = (patch: Partial<InstanceConfig>): void => onChange({ ...instance, ...patch })
  const updateProject = (index: number, next: ProjectPolicy): void =>
    onChange({
      ...instance,
      projects: instance.projects.map((project, current) => (current === index ? next : project))
    })
  const projectError = projectId !== '' && !PROJECT_ID.test(projectId.trim())
  const canAdd =
    PROJECT_ID.test(projectId.trim()) &&
    repoId !== '' &&
    !instance.projects.some((project) => project.projectId === projectId.trim())

  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold leading-6">{instance.displayName || instance.id}</h3>
          <p className="text-xs text-muted-foreground">{`${instance.id} · ${instance.baseUrl}`}</p>
        </div>
        <Button type="button" variant="ghost" size="xs" onClick={onRemove}>
          {translate('auto.components.forge-inbox.instance.remove', 'Remove instance')}
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`forge-instance-name-${instance.id}`}>
            {translate('auto.components.forge-inbox.instance.displayName', 'Display name')}
          </Label>
          <Input
            id={`forge-instance-name-${instance.id}`}
            value={instance.displayName}
            onChange={(event) => update({ displayName: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`forge-instance-url-${instance.id}`}>
            {translate('auto.components.forge-inbox.instance.baseUrl', 'GitLab URL')}
          </Label>
          <Input
            id={`forge-instance-url-${instance.id}`}
            value={instance.baseUrl}
            spellCheck={false}
            onChange={(event) => update({ baseUrl: event.target.value })}
          />
        </div>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {translate('auto.components.forge-inbox.instance.webhookUrl', 'Webhook URL')}
        {': '}
        <span className="select-all font-mono">{webhookUrl}</span>
      </p>

      <label className="mt-3 flex items-start gap-2 text-sm">
        <Checkbox
          className="mt-0.5"
          checked={instance.allowInsecureHttpApi}
          onCheckedChange={(checked) => update({ allowInsecureHttpApi: checked === true })}
        />
        <span>
          {translate(
            'auto.components.forge-inbox.instance.insecureApi',
            'Allow plaintext HTTP calls to the GitLab API'
          )}
        </span>
      </label>
      <label className="mt-2 flex items-start gap-2 text-sm">
        <Checkbox
          className="mt-0.5"
          checked={instance.allowLegacyPayloadDigestDedupe}
          onCheckedChange={(checked) =>
            update({ allowLegacyPayloadDigestDedupe: checked === true })
          }
        />
        <span>
          {translate(
            'auto.components.forge-inbox.instance.legacyDedupe',
            'Accept older payloads without a webhook UUID (deduplicated by content)'
          )}
        </span>
      </label>

      <div className="mt-4 flex flex-col gap-1.5">
        <Label htmlFor={`forge-usernames-${instance.id}`}>
          {translate('auto.components.forge-inbox.instance.usernames', 'My GitLab usernames')}
        </Label>
        <Input
          id={`forge-usernames-${instance.id}`}
          value={usernamesText}
          spellCheck={false}
          placeholder="alice, alice.smith"
          onChange={(event) => {
            setUsernamesText(event.target.value)
            update({ usernames: parseForgeUsernames(event.target.value) })
          }}
        />
      </div>

      <div className="mt-5">
        <span className="text-xs font-medium uppercase text-muted-foreground">
          {translate('auto.components.forge-inbox.instance.projects', 'Allowlisted projects')}
        </span>
        {instance.projects.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {translate(
              'auto.components.forge-inbox.instance.noProjects',
              'No project accepts events yet.'
            )}
          </p>
        ) : (
          instance.projects.map((project, index) => (
            <ForgeInboxProjectPolicyEditor
              key={project.projectId}
              policy={project}
              onChange={(next) => updateProject(index, next)}
              onRemove={() =>
                onChange({
                  ...instance,
                  projects: instance.projects.filter((_, current) => current !== index)
                })
              }
            />
          ))
        )}

        <div className="mt-3 grid grid-cols-1 gap-2 rounded-md border border-dashed border-border p-3 sm:grid-cols-[minmax(0,8rem)_minmax(0,1fr)_minmax(0,10rem)_auto]">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`forge-new-project-${instance.id}`}>
              {translate('auto.components.forge-inbox.instance.projectId', 'Project ID')}
            </Label>
            <Input
              id={`forge-new-project-${instance.id}`}
              value={projectId}
              inputMode="numeric"
              aria-invalid={projectError}
              onChange={(event) => setProjectId(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`forge-new-repo-${instance.id}`}>
              {translate('auto.components.forge-inbox.instance.workspace', 'Orca project')}
            </Label>
            <Select value={repoId} onValueChange={setRepoId}>
              <SelectTrigger id={`forge-new-repo-${instance.id}`} size="sm" className="w-full">
                <SelectValue
                  placeholder={translate(
                    'auto.components.forge-inbox.instance.pickRepo',
                    'Choose a project'
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {repos.map((repo) => (
                  <SelectItem key={repo.id} value={repo.id}>
                    {repo.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`forge-new-workspace-${instance.id}`}>
              {translate(
                'auto.components.forge-inbox.instance.workspaceId',
                'Workspace (optional)'
              )}
            </Label>
            <Input
              id={`forge-new-workspace-${instance.id}`}
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              size="sm"
              disabled={!canAdd}
              onClick={() => {
                onChange({
                  ...instance,
                  projects: [
                    ...instance.projects,
                    forgeNewProjectPolicy(projectId.trim(), repoId, workspaceId)
                  ]
                })
                setProjectId('')
                setWorkspaceId('')
              }}
            >
              {translate('auto.components.forge-inbox.instance.addProject', 'Add')}
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <ForgeInboxCredentialEditor
          credentials={credentials}
          onSet={onSetCredential}
          onClear={onClearCredential}
        />
      </div>
    </section>
  )
}

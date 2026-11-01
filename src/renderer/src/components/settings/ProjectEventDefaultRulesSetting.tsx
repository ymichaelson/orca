import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { MAX_RULES_BYTES } from '../../../../shared/forge-inbox-config'
import { normalizeProjectEventDefaultRules } from '../../../../shared/project-event-default-rules-settings'
import { SearchableSetting } from './SearchableSetting'

/** Rules are stored as UTF-8 bytes, so the limit is counted the same way the owner counts it. */
function rulesByteLength(rules: string): number {
  return new TextEncoder().encode(rules).length
}

/**
 * The rules template every project's first policy save starts from on the active host. Editing it
 * never touches a project that already has its own saved policy.
 */
export function ProjectEventDefaultRulesSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const saved = normalizeProjectEventDefaultRules(settings.projectEventDefaultRules)
  const [draft, setDraft] = useState(saved)
  useEffect(() => {
    setDraft(saved)
  }, [saved])
  const bytes = rulesByteLength(draft)
  const rejected = bytes > MAX_RULES_BYTES || draft.includes('\u0000')
  const dirty = draft !== saved
  return (
    <SearchableSetting
      title={titleText()}
      description={descriptionText()}
      keywords={['agent', 'project event', 'rules', 'template', 'template']}
      className="space-y-3"
    >
      <p className="text-sm font-semibold">{titleText()}</p>
      <p className="text-xs text-muted-foreground">{descriptionText()}</p>
      <div className="space-y-2">
        <Label htmlFor="project-event-default-rules">
          {translate('projectEventDefaultRules.rules', 'Rules')}
        </Label>
        <Textarea
          id="project-event-default-rules"
          value={draft}
          spellCheck={false}
          rows={12}
          variant="code"
          aria-invalid={rejected}
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className={rejected ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
          {translate('projectEventDefaultRules.rulesHelp', '{{used}} of {{limit}} bytes', {
            used: bytes,
            limit: MAX_RULES_BYTES
          })}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        disabled={rejected || !dirty}
        onClick={() => {
          void Promise.resolve(updateSettings({ projectEventDefaultRules: draft })).then(() => {
            toast.success(translate('projectEventDefaultRules.saved', 'Default rules saved'))
          })
        }}
      >
        {translate('projectEventDefaultRules.save', 'Save default rules')}
      </Button>
    </SearchableSetting>
  )
}

function titleText(): string {
  return translate('projectEventDefaultRules.title', 'Default project event rules')
}

function descriptionText(): string {
  return translate(
    'projectEventDefaultRules.description',
    'The rules a project starts from when you first enable its event agent. Projects already added keep their own copy; changing this only affects future first saves on this host.'
  )
}

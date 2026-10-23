import { translate } from '@/i18n/i18n'

export type ForgeWriteFailure = {
  reason:
    | 'stale-revision'
    | 'invalid-config'
    | 'instance-origin-conflict'
    | 'unknown-instance'
    | 'invalid-secret'
    | 'unprotected-storage'
    | 'project-not-found'
  configRevision?: number
  message?: string
  instanceId?: string
  gap?: string
}

/** Each refusal says what actually happened; nothing is retried behind the user's back. */
export function forgeWriteFailureMessage(failure: ForgeWriteFailure): string {
  switch (failure.reason) {
    case 'stale-revision':
      return translate(
        'auto.components.forge-inbox.settings.staleRevision',
        'The inbox config changed elsewhere (now revision {{revision}}). Reload before saving again.',
        { revision: failure.configRevision ?? 0 }
      )
    case 'invalid-config':
      return translate(
        'auto.components.forge-inbox.settings.invalidConfig',
        'The host rejected the config: {{message}}',
        { message: failure.message ?? '' }
      )
    case 'instance-origin-conflict':
      return translate(
        'auto.components.forge-inbox.settings.originConflict',
        'Instance {{instanceId}} is bound to a different GitLab URL. Remove it first to change the URL.',
        { instanceId: failure.instanceId ?? '' }
      )
    case 'unknown-instance':
      return translate(
        'auto.components.forge-inbox.settings.unknownInstance',
        'That GitLab instance no longer exists in the config.'
      )
    case 'invalid-secret':
      return translate(
        'auto.components.forge-inbox.settings.invalidSecret',
        'Secrets must be 1–8192 visible ASCII characters with no spaces.'
      )
    case 'unprotected-storage':
      return translate(
        'auto.components.forge-inbox.settings.unprotectedStorage',
        'No secure storage is available here ({{gap}}). The secret can be stored unprotected only with your explicit consent.',
        { gap: failure.gap ?? '' }
      )
    case 'project-not-found':
      return translate(
        'auto.components.forge-inbox.settings.projectNotFound',
        'That project is no longer allowlisted for this instance.'
      )
  }
}

import type { ForgeItemKind } from '../../../../shared/forge-inbox-types'
import type { ProjectEventActivityOutcome } from '../../../../shared/forge-inbox-project-event-activity'
import type {
  ProjectEventBindingFailureCode,
  ProjectEventBindingFailurePhase,
  ProjectEventBindingSecretProtection,
  ProjectEventBindingState
} from '../../../../shared/forge-inbox-project-binding'
import { PROJECT_EVENT_BINDING_FAILURE_CODES } from '../../../../shared/forge-inbox-project-binding'
import { translate } from '@/i18n/i18n'

// Why: users act on what happened, not on the host's internal codes, so every projection value
// gets copy here and an unmapped code falls back to generic wording instead of raw text.

const STATE_COPY: Record<ProjectEventBindingState, () => string> = {
  unconfigured: () =>
    translate('projectEventAgent.bindingState.unconfigured', 'Callback not registered yet.'),
  checking: () =>
    translate('projectEventAgent.bindingState.checking', 'Checking the GitLab project…'),
  registering: () =>
    translate('projectEventAgent.bindingState.registering', 'Registering the callback…'),
  verifying: () => translate('projectEventAgent.bindingState.verifying', 'Verifying the callback…'),
  connected: () => translate('projectEventAgent.bindingState.connected', 'Callback verified.'),
  failed: () =>
    translate('projectEventAgent.bindingState.failed', 'Registration or verification failed.')
}

const PHASE_COPY: Record<ProjectEventBindingFailurePhase, () => string> = {
  checking: () =>
    translate('projectEventAgent.bindingPhase.checking', 'while checking the project'),
  registering: () =>
    translate('projectEventAgent.bindingPhase.registering', 'while registering the callback'),
  verifying: () =>
    translate('projectEventAgent.bindingPhase.verifying', 'while verifying the callback')
}

const OUTCOME_COPY: Record<ProjectEventActivityOutcome, () => string> = {
  recorded: () =>
    translate('projectEventAgent.activity.recorded', 'Recorded; no notification was sent.'),
  notified: () => translate('projectEventAgent.activity.notified', 'Recorded and notified.'),
  waiting: () =>
    translate('projectEventAgent.activity.waiting', 'Waiting for later events before deciding.'),
  processing: () => translate('projectEventAgent.activity.processing', 'Processing.'),
  'needs-user': () =>
    translate('projectEventAgent.activity.needsUser', 'Needs your input in the inbox.'),
  done: () => translate('projectEventAgent.activity.done', 'Handled.'),
  failed: () => translate('projectEventAgent.activity.failed', 'Failed.'),
  unknown: () =>
    translate('projectEventAgent.activity.unknown', 'Status unknown; the event was received.')
}

const FAILURE_COPY: Record<ProjectEventBindingFailureCode, () => string> = {
  'not-gitlab': () =>
    translate(
      'projectEventAgent.bindingFailure.notGitlab',
      'This host does not see the address as a GitLab project, or it is not signed in to that GitLab instance.'
    ),
  'glab-unavailable': () =>
    translate(
      'projectEventAgent.bindingFailure.glabUnavailable',
      'The GitLab CLI (glab) is not available on this host.'
    ),
  unauthenticated: () =>
    translate(
      'projectEventAgent.bindingFailure.unauthenticated',
      'The host is not signed in to this GitLab instance.'
    ),
  forbidden: () =>
    translate(
      'projectEventAgent.bindingFailure.forbidden',
      'The host lacks permission for this GitLab project.'
    ),
  'project-not-found': () =>
    translate(
      'projectEventAgent.bindingFailure.projectNotFound',
      'GitLab could not find this project.'
    ),
  'no-hook-permission': () =>
    translate(
      'projectEventAgent.bindingFailure.noHookPermission',
      'The signed-in account cannot manage webhooks for this project.'
    ),
  network: () =>
    translate('projectEventAgent.bindingFailure.network', 'The host could not reach GitLab.'),
  aborted: () =>
    translate(
      'projectEventAgent.bindingFailure.aborted',
      'The request was cancelled before it finished.'
    ),
  'bad-response': () =>
    translate(
      'projectEventAgent.bindingFailure.badResponse',
      'GitLab returned a response the host could not read.'
    ),
  'invalid-config': () =>
    translate(
      'projectEventAgent.bindingFailure.invalidConfig',
      'The inbox receiver configuration is invalid.'
    ),
  unauthorized: () =>
    translate(
      'projectEventAgent.bindingFailure.unauthorized',
      'GitLab rejected the host credentials.'
    ),
  'not-found': () =>
    translate(
      'projectEventAgent.bindingFailure.notFound',
      'GitLab no longer has the resource this callback pointed to.'
    ),
  'callback-blocked': () =>
    translate(
      'projectEventAgent.bindingFailure.callbackBlocked',
      'GitLab blocks webhooks to local or private addresses by default. A GitLab administrator can allow only this exact callback host or address under Admin > Settings > Network > Outbound requests. Do not turn the protection off for the whole local network.'
    ),
  'invalid-request': () =>
    translate(
      'projectEventAgent.bindingFailure.invalidRequest',
      'GitLab rejected the webhook request as invalid.'
    ),
  'ownership-conflict': () =>
    translate(
      'projectEventAgent.bindingFailure.ownershipConflict',
      'Another integration already manages the matching webhook.'
    ),
  'too-many-hooks': () =>
    translate(
      'projectEventAgent.bindingFailure.tooManyHooks',
      'This project already has the maximum number of webhooks.'
    ),
  'event-configuration-rejected': () =>
    translate(
      'projectEventAgent.bindingFailure.eventConfigurationRejected',
      'GitLab accepted the webhook but refused some of the event types Orca requested.'
    ),
  'rate-limited': () =>
    translate(
      'projectEventAgent.bindingFailure.rateLimited',
      'GitLab is rate-limiting this host; try again later.'
    ),
  'unknown-outcome': () =>
    translate(
      'projectEventAgent.bindingFailure.unknownOutcome',
      'The host did not learn whether GitLab applied the change; re-check before retrying.'
    ),
  interrupted: () =>
    translate(
      'projectEventAgent.bindingFailure.interrupted',
      'The host stopped before it finished the request.'
    ),
  'unprotected-storage': () =>
    translate(
      'projectEventAgent.bindingFailure.unprotectedStorage',
      'This host cannot encrypt the webhook secret without your explicit consent.'
    ),
  'secret-unavailable': () =>
    translate(
      'projectEventAgent.bindingFailure.secretUnavailable',
      'There is no readable secret to rotate; register the callback again first.'
    ),
  'repo-not-found': () =>
    translate(
      'projectEventAgent.bindingFailure.repoNotFound',
      'This project no longer exists on the host.'
    ),
  'no-git-remote': () =>
    translate(
      'projectEventAgent.bindingFailure.noGitRemote',
      'The host found no Git remote for this project.'
    ),
  'remote-host-repo': () =>
    translate(
      'projectEventAgent.bindingFailure.remoteHostRepo',
      'The Git remote points at a host this binding does not manage.'
    ),
  'receiver-not-configured': () =>
    translate(
      'projectEventAgent.bindingFailure.receiverNotConfigured',
      'The inbox receiver is not configured on this host.'
    ),
  'binding-conflict': () =>
    translate(
      'projectEventAgent.bindingFailure.bindingConflict',
      'This GitLab project is already bound to a different Orca project.'
    ),
  'cleanup-failed': () =>
    translate(
      'projectEventAgent.bindingFailure.cleanupFailed',
      'Orca could not remove the GitLab webhook for a removed project. It will retry when the host restarts.'
    )
}

const KIND_COPY: Record<ForgeItemKind | 'unknown', () => string> = {
  issue: () => translate('projectEventAgent.activityKind.issue', 'Issue'),
  merge_request: () => translate('projectEventAgent.activityKind.mergeRequest', 'Merge request'),
  pipeline: () => translate('projectEventAgent.activityKind.pipeline', 'Pipeline'),
  project: () => translate('projectEventAgent.activityKind.project', 'Project'),
  unknown: () => translate('projectEventAgent.activityKind.unknown', 'Event')
}

/** Never "encrypted" for an unrecorded format: a stale binding cannot vouch for its bytes. */
export function secretProtectionCopy(
  protection: ProjectEventBindingSecretProtection | null
): string {
  if (protection === 'sealed') {
    return translate('projectEventAgent.secretProtection.sealed', 'Stored encrypted.')
  }
  if (protection === 'plaintext') {
    return translate(
      'projectEventAgent.secretProtection.plaintext',
      'Stored unencrypted on this host.'
    )
  }
  return translate(
    'projectEventAgent.secretProtection.unknown',
    'How the secret is stored was not recorded.'
  )
}

function genericFailureCopy(): string {
  return translate(
    'projectEventAgent.bindingFailure.generic',
    'Registration or verification failed. Retry, or check the host GitLab permissions.'
  )
}

export function bindingStateCopy(state: ProjectEventBindingState): string {
  return STATE_COPY[state]()
}

export function bindingFailurePhaseCopy(phase: ProjectEventBindingFailurePhase): string {
  return PHASE_COPY[phase]()
}

export function activityKindCopy(kind: ForgeItemKind | 'unknown'): string {
  return KIND_COPY[kind]()
}

export function activityOutcomeCopy(outcome: ProjectEventActivityOutcome): string {
  return OUTCOME_COPY[outcome]()
}

/** Unknown codes never reach the user verbatim; they share the generic retry copy. */
export function bindingFailureCopy(code: string): string {
  const known = PROJECT_EVENT_BINDING_FAILURE_CODES.find((entry) => entry === code)
  return known === undefined ? genericFailureCopy() : FAILURE_COPY[known]()
}

/**
 * Why rotate gets its own wording: a rejected rotation already promoted the new secret, so
 * telling the user the rotation failed would hide that the remote is now on the new secret.
 */
export function bindingActionFailureCopy(action: 'retry' | 'rotate', code: string): string {
  if (action === 'rotate' && code === 'event-configuration-rejected') {
    return translate(
      'projectEventAgent.bindingFailure.eventConfigurationRejectedAfterRotate',
      'The secret was updated, but GitLab refused some of the event types Orca requested.'
    )
  }
  return bindingFailureCopy(code)
}

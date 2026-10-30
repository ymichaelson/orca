import { translate } from '@/i18n/i18n'

// Why: event intake, project policy and context codes; the user acts on the project setup.
export const EVENT_ERROR_COPY: Record<string, () => string> = {
  'policy-revoked': () =>
    translate(
      'auto.components.forge-inbox.display.errorPolicyRevoked',
      'The project policy no longer allows this.'
    ),
  'context-already-fetched': () =>
    translate(
      'auto.components.forge-inbox.display.errorContextAlreadyFetched',
      'The context was already fetched.'
    ),
  'context-rounds-exhausted': () =>
    translate(
      'auto.components.forge-inbox.display.errorContextRounds',
      'The context fetch limit was reached.'
    ),
  'context-unavailable': () =>
    translate(
      'auto.components.forge-inbox.display.errorContextUnavailable',
      'The context could not be fetched.'
    ),
  'context-unchanged': () =>
    translate(
      'auto.components.forge-inbox.display.errorContextUnchanged',
      'The context did not change.'
    ),
  'event-project-mismatch': () =>
    translate(
      'auto.components.forge-inbox.display.errorEventProjectMismatch',
      'The event belongs to a different project.'
    ),
  'event-subject-unsupported': () =>
    translate(
      'auto.components.forge-inbox.display.errorEventSubjectUnsupported',
      'This kind of event has no item to attach to.'
    ),
  'binding-mismatch': () =>
    translate(
      'auto.components.forge-inbox.display.errorBindingMismatch',
      'The event does not match the project it was sent to.'
    ),
  'binding-missing': () =>
    translate(
      'auto.components.forge-inbox.display.errorBindingMissing',
      'The project binding is missing.'
    ),
  'body-too-large': () =>
    translate(
      'auto.components.forge-inbox.display.errorBodyTooLarge',
      'The event was too large to store.'
    ),
  'dirty-observation': () =>
    translate(
      'auto.components.forge-inbox.display.errorDirtyObservation',
      'The data changed while it was being read.'
    ),
  'invalid-action': () =>
    translate(
      'auto.components.forge-inbox.display.errorInvalidAction',
      'The decision named an action Orca does not know.'
    ),
  'invalid-config': () =>
    translate(
      'auto.components.forge-inbox.display.errorInvalidConfig',
      'The event decision settings are invalid.'
    ),
  'missing-checkout': () =>
    translate(
      'auto.components.forge-inbox.display.errorMissingCheckout',
      'The repository has no local checkout to read.'
    ),
  'notification-unsupported': () =>
    translate(
      'auto.components.forge-inbox.display.errorNotificationUnsupported',
      'This event does not map to a notification.'
    ),
  'provisional-head': () =>
    translate(
      'auto.components.forge-inbox.display.errorProvisionalHead',
      'The change has not been confirmed by GitLab yet.'
    ),
  'stale-config': () =>
    translate(
      'auto.components.forge-inbox.display.errorStaleConfig',
      'The settings changed while this was running.'
    ),
  'head-moved': () =>
    translate(
      'auto.components.forge-inbox.display.errorHeadMoved',
      'The change moved on meanwhile.'
    ),
  'invalid-input': () =>
    translate(
      'auto.components.forge-inbox.display.errorInvalidInput',
      'The event could not be read.'
    ),
  'item-identity-missing': () =>
    translate(
      'auto.components.forge-inbox.display.errorItemIdentity',
      'The event does not identify its item.'
    ),
  'missing-link': () =>
    translate(
      'auto.components.forge-inbox.display.errorMissingLink',
      'The project is not linked to a repository.'
    ),
  'missing-policy': () =>
    translate(
      'auto.components.forge-inbox.display.errorMissingPolicy',
      'The project has no policy yet.'
    ),
  'policy-disabled': () =>
    translate(
      'auto.components.forge-inbox.display.errorPolicyDisabled',
      'The project policy is turned off.'
    ),
  'question-rounds-exhausted': () =>
    translate(
      'auto.components.forge-inbox.display.errorQuestionRounds',
      'The question limit for this item was reached.'
    ),
  'queue-full': () =>
    translate('auto.components.forge-inbox.display.errorQueueFull', 'The event queue was full.')
}

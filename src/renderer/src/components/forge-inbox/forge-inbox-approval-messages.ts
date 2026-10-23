import type {
  ForgeCommentApprovalFailure,
  ForgeDiscussRefusal
} from '../../../../shared/forge-inbox-rpc-types'
import { translate } from '@/i18n/i18n'

/** Why an approval stopped. Nothing was written unless the outcome said so. */
export function forgeApprovalFailureMessage(reason: ForgeCommentApprovalFailure): string {
  switch (reason) {
    case 'not-found':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.notFound',
        'This proposal no longer exists on the host.'
      )
    case 'not-pending':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.notPending',
        'This proposal was already handled.'
      )
    case 'stale':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.stale',
        'The project policy changed after this draft was made. Ask the agent for a fresh draft.'
      )
    case 'not-a-comment':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.notAComment',
        'This proposal is not a comment, so it cannot be sent from here.'
      )
    case 'draft-mismatch':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.draftMismatch',
        'The draft on the host differs from the one you reviewed. Nothing was sent.'
      )
    case 'head-unavailable':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.headUnavailable',
        'The current head of the merge request could not be read. Nothing was sent.'
      )
    case 'head-moved':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.headMoved',
        'The branch moved since this draft was made. Review a fresh draft.'
      )
    case 'delivery-failed':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.deliveryFailed',
        'GitLab rejected the comment.'
      )
    case 'delivery-unconfirmed':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.deliveryUnconfirmed',
        'The comment may have been sent, but the response could not be confirmed. Check GitLab before trying again.'
      )
    case 'marker-ambiguous':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.markerAmbiguous',
        'More than one matching comment was found. Check GitLab before trying again.'
      )
    case 'marker-not-found':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.markerNotFound',
        'The earlier comment could not be found. Check GitLab before trying again.'
      )
    case 'marker-unavailable':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.markerUnavailable',
        'The earlier comment could not be checked. Check GitLab before trying again.'
      )
    case 'unauthorized':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.unauthorized',
        'GitLab rejected the stored write credential.'
      )
    case 'forbidden':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.forbidden',
        'GitLab did not allow this action for the stored credential.'
      )
    case 'rate-limited':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.rateLimited',
        'GitLab rate-limited this action. Try again later.'
      )
    case 'too-large':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.tooLarge',
        'The comment is too large for GitLab.'
      )
    case 'bad-response':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.badResponse',
        'GitLab returned an unexpected response.'
      )
    case 'network':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.network',
        'The host could not reach GitLab.'
      )
    case 'stale-config':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.staleConfig',
        'The inbox config changed. Reload before approving.'
      )
    case 'no-credential':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.noCredential',
        'No write credential is stored for this instance. Add one in Inbox settings.'
      )
    case 'not-approved':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.notApproved',
        'The proposal is not approved.'
      )
    case 'not-authorised':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.notAuthorised',
        'The host is not authorised for this action.'
      )
    case 'cancelled':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.cancelled',
        'The run was cancelled before this action ran.'
      )
  }
}

/** Discuss never invents an answer: a refusal says the original session was not resumed. */
export function forgeDiscussRefusalMessage(reason: ForgeDiscussRefusal): string {
  switch (reason) {
    case 'message-empty':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.discussMessageEmpty',
        'Write a message before sending.'
      )
    case 'message-too-large':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.discussMessageTooLarge',
        'That message is too large.'
      )
    case 'run-missing':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.discussRunMissing',
        'That run no longer exists on the host.'
      )
    case 'run-not-analysed':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.discussRunNotAnalysed',
        'That run has no analysed session to discuss.'
      )
    case 'project-unavailable':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.discussProjectUnavailable',
        'The project is not available on this host.'
      )
    case 'session-missing':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.discussSessionMissing',
        'The original session could not be found and was not reopened.'
      )
    case 'session-not-protected':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.discussSessionNotProtected',
        'The original session is not a protected analysis session, so it was not resumed.'
      )
    case 'host-unavailable':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.discussHostUnavailable',
        'This host cannot prove the original session, so Discuss is unavailable.'
      )
    case 'send-refused':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.discussSendRefused',
        'The original session refused the message.'
      )
  }
}

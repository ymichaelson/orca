import type {
  ForgeCommentApprovalFailure,
  ForgePatchDiffFailure
} from '../../../../shared/forge-inbox-rpc-types'
import type {
  ForgePatchApplyFailureReason,
  ForgePatchApprovalRefusal
} from '../../../../shared/forge-patch-request'
import type {
  ForgePushApplyRefusal,
  ForgePushApprovalRefusal,
  ForgePushFailureReason
} from '../../../../shared/forge-push'
import { translate } from '@/i18n/i18n'

/** Every approval stops for a coded reason; none of them means a write succeeded. */
export type ForgeApprovalFailure =
  | ForgeCommentApprovalFailure
  | ForgePatchApprovalRefusal
  | ForgePatchApplyFailureReason
  | ForgePushApprovalRefusal
  | ForgePushApplyRefusal
  | ForgePushFailureReason
  | ForgePatchDiffFailure
  | 'unconfirmed'

/** Why an approval stopped. Nothing was written unless the outcome said so. */
export function forgeApprovalFailureMessage(reason: ForgeApprovalFailure): string {
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
    case 'not-a-patch':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.notAPatch',
        'This proposal is not a file change, so it cannot be applied from here.'
      )
    case 'not-a-push':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.notAPush',
        'This proposal is not a push, so it cannot be pushed from here.'
      )
    case 'already-applied':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.alreadyApplied',
        'This file change was already applied.'
      )
    case 'already-pushed':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.alreadyPushed',
        'This push was already attempted.'
      )
    case 'draft-mismatch':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.draftMismatch',
        'The draft on the host differs from the one you reviewed. Nothing was sent.'
      )
    case 'plan-mismatch':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.planMismatch',
        'The push plan on the host differs from the one you reviewed. Nothing was pushed.'
      )
    case 'head-unavailable':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.headUnavailable',
        'The current branch head could not be read. Nothing happened.'
      )
    case 'head-moved':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.headMoved',
        'The branch moved since this draft was made. Review a fresh draft.'
      )
    case 'base-missing':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.baseMissing',
        'The base revision this change was built on is no longer available. Nothing was written.'
      )
    case 'base-unexpected':
    case 'base-mismatch':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.baseMismatch',
        'The base revision does not match the approved one. Nothing was written.'
      )
    case 'base-unavailable':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.baseUnavailable',
        'The base commit could not be read from GitLab. Nothing was pushed.'
      )
    case 'base-unsupported':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.baseUnsupported',
        'This project’s base tree cannot be rebuilt exactly, so nothing was written or pushed.'
      )
    case 'base-unverified':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.baseUnverified',
        'The base commit could not be verified exactly. Nothing was pushed.'
      )
    case 'diff-too-large':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.diffTooLarge',
        'This change is too large to show exactly here. Nothing was written.'
      )
    case 'source-unavailable':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.sourceUnavailable',
        'A file needed for this change could not be read. Nothing was written.'
      )
    case 'path-unsafe':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.pathUnsafe',
        'The change contains a path this host will not write. Nothing was written.'
      )
    case 'write-failed':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.writeFailed',
        'The host could not write the approved files.'
      )
    case 'tree-invalid':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.treeInvalid',
        'The approved file tree could not be built. Nothing was pushed.'
      )
    case 'tree-mismatch':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.treeMismatch',
        'The built file tree differs from the approved one. Nothing was pushed.'
      )
    case 'git-unavailable':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.gitUnavailable',
        'Git is not available on this host, so nothing was pushed.'
      )
    case 'project-unavailable':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.projectUnavailable',
        'The project is not available on this host.'
      )
    case 'workspace-failed':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.workspaceFailed',
        'The host could not prepare a private work directory. Nothing was pushed.'
      )
    case 'aborted':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.aborted',
        'The change stopped before it finished. Check the files before trying again.'
      )
    case 'rejected':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.pushRejected',
        'GitLab rejected the push.'
      )
    case 'internal':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.internal',
        'The action failed on the host.'
      )
    case 'unconfirmed':
      return translate(
        'auto.components.forge-inbox.forge-inbox-approval-messages.unconfirmed',
        'The push may have succeeded, but the remote answer could not be confirmed. Check GitLab before trying again.'
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

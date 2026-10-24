import type { ForgeDiscussRefusal } from '../../../../shared/forge-inbox-rpc-types'
import { translate } from '@/i18n/i18n'

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

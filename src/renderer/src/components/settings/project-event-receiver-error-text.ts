import { translate } from '@/i18n/i18n'
import {
  PROJECT_EVENT_RECEIVER_LISTENER_ERROR_CODES as CODES,
  type ProjectEventReceiverListenerErrorCode
} from '../../../../shared/project-event-receiver-listener-error-codes'

const LISTENER_ERROR_TEXT = {
  [CODES.addressInUse]: {
    key: 'webhook.error.portInUse',
    fallback: 'The port is already in use. Stop the other process or choose another port.'
  },
  [CODES.permissionDenied]: {
    key: 'webhook.error.permissionDenied',
    fallback: 'Permission denied while opening the listen port.'
  },
  [CODES.addressNotAvailable]: {
    key: 'webhook.error.addressUnavailable',
    fallback: 'The listen address is not available on this host.'
  },
  [CODES.listenFailed]: {
    key: 'webhook.error.listenFailed',
    fallback: 'The listener failed to start.'
  },
  [CODES.externalPlaintextNotAcknowledged]: {
    key: 'webhook.error.externalPlaintextNotAcknowledged',
    fallback:
      'External plaintext HTTP is not acknowledged. Use a loopback address or acknowledge the risk.'
  },
  [CODES.listenerStopped]: {
    key: 'webhook.error.listenerStopped',
    fallback: 'The listener stopped. Retry to start it again.'
  }
} satisfies Record<ProjectEventReceiverListenerErrorCode, { key: string; fallback: string }>

function isListenerErrorCode(error: string): error is ProjectEventReceiverListenerErrorCode {
  return Object.hasOwn(LISTENER_ERROR_TEXT, error)
}

/** Unknown codes stay opaque: a host might echo a message that is not ours to display. */
export function receiverListenerErrorText(error: string | null): string | null {
  if (error === null) {
    return null
  }
  if (!isListenerErrorCode(error)) {
    return translate('webhook.error.unknown', 'The listener failed to start.')
  }
  const text = LISTENER_ERROR_TEXT[error]
  return translate(text.key, text.fallback)
}

import type { ForgeInboxErrorSource } from '../../../../shared/forge-inbox-error-source'
import { translate } from '@/i18n/i18n'
import { EVENT_ERROR_COPY } from './forge-inbox-event-error-copy'
import { RUN_ERROR_COPY } from './forge-inbox-run-error-copy'
import { SERVICE_ERROR_COPY } from './forge-inbox-service-error-copy'

const ERROR_CODE_COPY: Record<string, () => string> = {
  ...RUN_ERROR_COPY,
  ...EVENT_ERROR_COPY,
  ...SERVICE_ERROR_COPY
}

export function forgeGenericErrorLabel(): string {
  return translate('auto.components.forge-inbox.display.errorGeneric', 'Something went wrong.')
}

/** Covers run, decision and delivery codes our producers emit; anything else stays generic. */
export function forgeErrorCodeLabel(code: string, source?: ForgeInboxErrorSource): string {
  if (source !== 'gitlab' && code === 'unauthorized') {
    return source === 'decision-provider'
      ? translate(
          'projectEventInbox.errorProviderAuth',
          'The event decision service rejected the host credentials.'
        )
      : translate('projectEventInbox.errorAuth', 'The service rejected the host credentials.')
  }
  if (source !== 'gitlab' && code === 'network') {
    return source === 'decision-provider'
      ? translate(
          'projectEventInbox.errorProviderNetwork',
          'The host could not reach the event decision service.'
        )
      : translate('projectEventInbox.errorNetwork', 'The host could not reach the service.')
  }
  return Object.hasOwn(ERROR_CODE_COPY, code) ? ERROR_CODE_COPY[code]() : forgeGenericErrorLabel()
}

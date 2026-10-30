import { translate } from '@/i18n/i18n'

// Why: GitLab and decision-service transport codes; the user acts on credentials or connectivity.
export const SERVICE_ERROR_COPY: Record<string, () => string> = {
  'bad-response': () =>
    translate(
      'auto.components.forge-inbox.display.errorBadResponse',
      'The service sent a reply Orca could not read.'
    ),
  forbidden: () =>
    translate(
      'auto.components.forge-inbox.display.errorForbidden',
      'GitLab denied access to this project.'
    ),
  'no-credential': () =>
    translate(
      'auto.components.forge-inbox.display.errorNoCredential',
      'No GitLab credential is available on the host.'
    ),
  'not-found': () =>
    translate(
      'auto.components.forge-inbox.display.errorNotFound',
      'GitLab could not find the item.'
    ),
  overloaded: () =>
    translate(
      'auto.components.forge-inbox.display.errorOverloaded',
      'The event decision service is overloaded.'
    ),
  'rate-limited': () =>
    translate(
      'auto.components.forge-inbox.display.errorRateLimited',
      'The service is rate limiting the host.'
    ),
  'request-too-large': () =>
    translate(
      'auto.components.forge-inbox.display.errorRequestTooLarge',
      'The request was too large to send.'
    ),
  'response-too-large': () =>
    translate(
      'auto.components.forge-inbox.display.errorResponseTooLarge',
      'The reply was too large to read.'
    ),
  timeout: () =>
    translate(
      'auto.components.forge-inbox.display.errorTimeout',
      'The service took too long to answer.'
    ),
  'too-large': () =>
    translate(
      'auto.components.forge-inbox.display.errorTooLarge',
      'The GitLab data was too large to read.'
    ),
  network: () =>
    translate(
      'auto.components.forge-inbox.display.errorNetwork',
      'The host could not reach GitLab.'
    ),
  unauthorized: () =>
    translate(
      'auto.components.forge-inbox.display.errorUnauthorized',
      'GitLab rejected the host credentials.'
    )
}

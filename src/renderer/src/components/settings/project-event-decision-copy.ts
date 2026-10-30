import { translate } from '@/i18n/i18n'
import type {
  ProjectEventDecisionFailureCode,
  ProjectEventDecisionProbeResult,
  ProjectEventDecisionProvider
} from '../../../../shared/project-event-decision'

function isLoopbackAddress(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/** Says where decision payloads go; Laya is only "local" when its address is loopback on that host. */
export function decisionProviderDisclosure(
  provider: ProjectEventDecisionProvider,
  baseUrl: string
): string {
  if (provider === 'jev') {
    return translate(
      'projectEventDecision.disclosure.jev',
      'Events and your project rules are sent to TypeSafe (Jev) to choose the next step. Orca sends bounded event facts and rule text, never an API credential or repository contents.'
    )
  }
  if (baseUrl === '') {
    return translate(
      'projectEventDecision.disclosure.layaUnset',
      'Enter the address of your Laya deployment. Whether it runs on this host or elsewhere depends on that address; Orca does not assume it stays local.'
    )
  }
  return isLoopbackAddress(baseUrl)
    ? translate(
        'projectEventDecision.disclosure.layaLocal',
        'Decisions are requested from {{url}} on this host itself. Event facts and rule text stay on this machine, unless that service forwards them.',
        { url: baseUrl }
      )
    : translate(
        'projectEventDecision.disclosure.layaRemote',
        'Decisions are requested from {{url}}, which is not this machine. Event facts and rule text are sent there.',
        { url: baseUrl }
      )
}

function probeFailureText(code: ProjectEventDecisionFailureCode): string {
  switch (code) {
    case 'invalid-config':
      return translate(
        'projectEventDecision.probe.invalidConfig',
        'Check the provider settings and API key, save them, and test again.'
      )
    case 'invalid-input':
      return translate(
        'projectEventDecision.probe.invalidInput',
        'The service rejected the test request. Check that it implements the Jev/Laya decision endpoint.'
      )
    case 'request-too-large':
    case 'response-too-large':
      return translate(
        'projectEventDecision.probe.tooLarge',
        'The service returned more data than Orca accepts. Check that the address points to a Jev/Laya decision service.'
      )
    case 'bad-response':
      return translate(
        'projectEventDecision.probe.badResponse',
        'The service answered with an unexpected response. Check that the address points to a Jev/Laya decision service.'
      )
    case 'unauthorized':
      return translate(
        'projectEventDecision.probe.unauthorized',
        'The service rejected the saved API key. Save a valid key and test again.'
      )
    case 'rate-limited':
      return translate(
        'projectEventDecision.probe.rateLimited',
        'The service is rate limiting requests right now. Try again later.'
      )
    case 'overloaded':
      return translate(
        'projectEventDecision.probe.overloaded',
        'The service is temporarily overloaded. Try again later.'
      )
    case 'aborted':
      return translate(
        'projectEventDecision.probe.aborted',
        'The test was cancelled before the service answered.'
      )
    case 'timeout':
      return translate(
        'projectEventDecision.probe.timeout',
        'The service did not answer in time. Check the address and network path.'
      )
    case 'network':
      return translate(
        'projectEventDecision.probe.network',
        'Could not reach the service from this host. Check the address, network and proxy.'
      )
  }
}

/** Localized outcome of the user-triggered probe; carries no key or request body. */
export function decisionProbeResultText(result: ProjectEventDecisionProbeResult): string {
  if (!result.ok) {
    return probeFailureText(result.code)
  }
  const base = translate(
    'projectEventDecision.probe.connected',
    'Connected. {{provider}} answered with model {{model}}.',
    { provider: result.provider === 'jev' ? 'Jev' : 'Laya', model: result.model }
  )
  return result.usedDefaultModel
    ? `${base} ${translate(
        'projectEventDecision.probe.defaultModel',
        'No model was saved, so the provider default was used.'
      )}`
    : base
}

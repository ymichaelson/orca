import { vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { HOST_TEST_SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  attach,
  hostTestState
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { createFakeCancelHost } from './forge-inbox-project-event-run-cancel-test-kit'

export { HOST_TEST_SESSION }

/**
 * The real structured host with a real attached session, so its Stop admission, fence and operation
 * record are the production ones; only the journal read is served by the fake turn list.
 */
export async function openRealCancelHost(journal: ReturnType<typeof createFakeCancelHost>) {
  await attach()
  const { host, store } = hostTestState()
  vi.spyOn(host, 'history').mockImplementation(journal.host.history)
  const cancels = vi.spyOn(host, 'cancel')
  return {
    host,
    cancels,
    leaseFence: (): number | undefined => store.getRecord(HOST_TEST_SESSION)?.lease.runtimeFence
  }
}

/** Where the production runtime looks for its structured host. */
export function installRegistryHost(host: StructuredAgentSessionHost): () => void {
  setStructuredAgentSessionHost(host)
  return () => setStructuredAgentSessionHost(null)
}

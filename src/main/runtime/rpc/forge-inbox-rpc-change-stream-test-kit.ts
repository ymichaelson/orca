import { INSTANCE_ID } from '../../forge-inbox/forge-inbox-webhook-test-harness'
import {
  createFakeGitlab,
  mergeRequestHookBody
} from '../../forge-inbox/forge-inbox-gitlab-fake-server'
import {
  freePort,
  listenerOn,
  postHook,
  provision
} from '../../forge-inbox/forge-inbox-owner-service-test-kit'
import type { ForgeInboxLedger } from '../../forge-inbox/forge-inbox-ledger'
import {
  recordOf,
  createForgeRpcHarness,
  recordsOf,
  seedItem,
  type ForgeRpcHarness,
  type ForgeStream
} from './forge-inbox-rpc-test-kit'

export const SCOPE = { instanceId: INSTANCE_ID }
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

export const changeSeqs = (stream: ForgeStream) =>
  stream.frames.filter((frame) => frame.type === 'change').map((frame) => Number(frame.seq))

export const readyOf = (stream: ForgeStream) =>
  recordOf(stream.frames.find((frame) => frame.type === 'ready'))

/** Every durable change seq, paged through the public read route. */
export async function durableSeqs(harness: ForgeRpcHarness, ownerHostId: string) {
  const seqs: number[] = []
  let afterSeq = 0
  for (;;) {
    const page = await harness.ok('forgeInbox.getChanges', { ownerHostId, afterSeq, limit: 100 })
    seqs.push(...recordsOf(page.changes).map((change) => Number(change.seq)))
    if (page.hasMore !== true) {
      return seqs
    }
    afterSeq = Number(page.nextSeq)
  }
}

/** Adds real ingested items on a second ledger connection until the durable head passes the target. */
export function seedUntilHead(ledger: ForgeInboxLedger, ownerHostId: string, head: number) {
  let iid = 1000
  while (ledger.readChangeHead(SCOPE) <= head) {
    iid += 1
    seedItem(ledger, ownerHostId, iid)
  }
}

/** Starts the real webhook listener so a delivery commits through the owner service's own ledger. */
export async function openWebhookIngress(harness: ForgeRpcHarness) {
  const service = harness.runtime.forgeInboxService()
  const port = await freePort()
  await provision(service, listenerOn(port))
  let delivery = 0
  return {
    async deliver() {
      delivery += 1
      const response = await postHook(
        port,
        mergeRequestHookBody({ reviewers: ['me'], sha: delivery.toString(16).padStart(40, '0') }),
        `live-${delivery}`
      )
      if (response.status >= 300) {
        throw new Error(`hook rejected: ${response.status}`)
      }
      await service.settled()
    }
  }
}

/** A harness whose owner reads from the in-memory fake GitLab, so webhook deliveries become real items. */
export function createStreamHarness() {
  const gitlab = createFakeGitlab()
  return createForgeRpcHarness({ http: { fetch: (url) => gitlab.fetch(url) } })
}

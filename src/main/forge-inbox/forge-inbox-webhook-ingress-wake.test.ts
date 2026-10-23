import { afterEach, describe, expect, it } from 'vitest'
import { ForgeWebhookIngress } from './forge-inbox-webhook-ingress'
import { postHook } from './forge-inbox-owner-service-test-kit'
import {
  createWebhookHarness,
  WEBHOOK_TOKEN,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'
import { mergeRequestHookBody } from './forge-inbox-gitlab-fake-server'

describe('forge inbox webhook ingress wake', () => {
  let harness: WebhookHarness
  let ingress: ForgeWebhookIngress | null = null
  afterEach(async () => {
    await ingress?.stop()
    ingress = null
    harness.dispose()
  })

  async function listen(onAdmitted: () => void) {
    harness = createWebhookHarness()
    const ledger = harness.open()
    harness.configure(ledger, webhookConfig([webhookInstance()]))
    ingress = new ForgeWebhookIngress(ledger, { onAdmitted })
    const { port } = await ingress.listen({ host: '127.0.0.1', port: 0 })
    return { ledger, port }
  }

  it('wakes once per newly committed delivery, not for duplicates or rejections', async () => {
    let wakes = 0
    const { port } = await listen(() => (wakes += 1))
    const body = mergeRequestHookBody()

    await expect(postHook(port, body, 'm-1')).resolves.toMatchObject({ status: 202 })
    await expect(postHook(port, body, 'm-1')).resolves.toMatchObject({
      text: expect.stringContaining('duplicate')
    })
    await expect(postHook(port, body, 'm-2', `${WEBHOOK_TOKEN}-wrong`)).resolves.toMatchObject({
      status: 401
    })

    expect(wakes).toBe(1)
  })

  it('still acknowledges a committed delivery when the wake callback throws', async () => {
    const { ledger, port } = await listen(() => {
      throw new Error('scheduler exploded')
    })

    await expect(postHook(port, mergeRequestHookBody(), 'm-1')).resolves.toMatchObject({
      status: 202,
      text: expect.stringContaining('queued')
    })

    expect(ledger.getWebhookQueueStatus()).toMatchObject({ pending: 1 })
  })
})

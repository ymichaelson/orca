import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { ForgeWebhookIngress } from './forge-inbox-webhook-ingress'
import { setProjectBindingProgress, upsertProjectBinding } from './forge-inbox-project-binding'
import { setProjectBindingSecret } from './forge-inbox-project-binding-secret'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { mergeRequestHookBody } from './forge-inbox-gitlab-fake-server'
import {
  createWebhookHarness,
  PROJECT_ID,
  WEBHOOK_TOKEN,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'
import type { ForgeInboxLedger } from './forge-inbox-ledger'

function postHook(
  port: number,
  path: string,
  body: unknown,
  id: string,
  token = WEBHOOK_TOKEN
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gitlab-token': token,
          'x-gitlab-event': 'Merge Request Hook',
          'webhook-id': id,
          'x-gitlab-webhook-uuid': 'cfg-1',
          'x-gitlab-event-uuid': `evt-${id}`
        },
        agent: false
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

function connectBinding(ledger: ForgeInboxLedger, bindingId: string): void {
  const ctx = ledger.ledgerContext()
  upsertProjectBinding(ctx, {
    bindingId,
    projectPath: '/repo',
    gitlabHost: 'gitlab.test',
    gitlabPath: 'group/demo',
    gitlabProjectId: Number(PROJECT_ID),
    callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
  })
  const secret = setProjectBindingSecret(ctx, { bindingId, secret: WEBHOOK_TOKEN })
  if (!secret.ok) {
    throw new Error(`fixture could not store the binding secret: ${secret.reason}`)
  }
  linkProjectEventBinding(ctx, { repoId: 'repo-1', bindingId })
  const policy = updateProjectEventPolicy(ctx, {
    repoId: 'repo-1',
    expectedGeneration: 0,
    patch: { enabled: true }
  })
  if (!policy.ok) {
    throw new Error(`fixture could not enable the project policy: ${policy.reason}`)
  }
  setProjectBindingProgress(ctx, bindingId, { state: 'connected', hookId: 7 })
}

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
    const bindingId = randomUUID()
    connectBinding(ledger, bindingId)
    ingress = new ForgeWebhookIngress(ledger, { onAdmitted })
    const { port } = await ingress.listen({ host: '127.0.0.1', port: 0 })
    return { ledger, port, path: `/webhooks/gitlab/${bindingId}` }
  }

  it('wakes once per newly committed delivery, not for duplicates or rejections', async () => {
    let wakes = 0
    const { port, path } = await listen(() => (wakes += 1))
    const body = mergeRequestHookBody()

    await expect(postHook(port, path, body, 'm-1')).resolves.toMatchObject({ status: 202 })
    await expect(postHook(port, path, body, 'm-1')).resolves.toMatchObject({
      text: expect.stringContaining('duplicate')
    })
    await expect(
      postHook(port, path, body, 'm-2', `${WEBHOOK_TOKEN}-wrong`)
    ).resolves.toMatchObject({
      status: 401
    })

    expect(wakes).toBe(1)
  })

  it('still acknowledges a committed delivery when the wake callback throws', async () => {
    const { ledger, port, path } = await listen(() => {
      throw new Error('scheduler exploded')
    })

    await expect(postHook(port, path, mergeRequestHookBody(), 'm-1')).resolves.toMatchObject({
      status: 202,
      text: expect.stringContaining('queued')
    })

    expect(ledger.getWebhookQueueStatus()).toMatchObject({ pending: 1 })
  })
})

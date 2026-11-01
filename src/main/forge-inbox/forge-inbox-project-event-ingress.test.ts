import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ForgeWebhookIngress } from './forge-inbox-webhook-ingress'
import { createWebhookHarness, type WebhookHarness } from './forge-inbox-webhook-test-harness'
import { setProjectBindingProgress, upsertProjectBinding } from './forge-inbox-project-binding'
import { setProjectBindingSecret } from './forge-inbox-project-binding-secret'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import type { ForgeInboxLedger } from './forge-inbox-ledger'

const SECRET = 'binding-secret-value'
const PROJECT_ID = 3
const BODY = JSON.stringify({ object_kind: 'merge_request', project: { id: PROJECT_ID } })

function post(
  port: number,
  path: string,
  token: string,
  id = 'delivery-1',
  event = 'Merge Request Hook',
  body: string = BODY
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
          'x-gitlab-event': event,
          'webhook-id': id
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
    req.end(body)
  })
}

const PUSH_BODY = JSON.stringify({
  object_kind: 'push',
  project: { id: PROJECT_ID, path_with_namespace: 'group/demo' },
  project_id: PROJECT_ID,
  ref: 'refs/heads/feature',
  before: 'a'.repeat(40),
  after: 'b'.repeat(40),
  commits: []
})

const NOTE_BODY = JSON.stringify({ object_kind: 'note', project: { id: PROJECT_ID } })

describe('project event webhook ingress', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let ingress: ForgeWebhookIngress
  let bindingId: string
  let port: number

  const stored = () =>
    ledger
      .ledgerContext()
      .db.prepare(
        `SELECT binding_id, instance_id, project_id, state, policy_generation
         FROM webhook_deliveries`
      )
      .all()

  beforeEach(async () => {
    harness = createWebhookHarness()
    ledger = harness.open()
    bindingId = randomUUID()
    const ctx = ledger.ledgerContext()
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: '/repo',
      gitlabHost: 'gitlab.test',
      gitlabPath: 'group/demo',
      gitlabProjectId: PROJECT_ID,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
    })
    const secret = setProjectBindingSecret(ctx, { bindingId, secret: SECRET })
    if (!secret.ok) {
      throw new Error(`fixture could not store the binding secret: ${secret.reason}`)
    }
    linkProjectEventBinding(ctx, { repoId: 'repo-1', bindingId })
    updateProjectEventPolicy(ctx, {
      repoId: 'repo-1',
      expectedGeneration: 0,
      patch: { enabled: true }
    })
    setProjectBindingProgress(ctx, bindingId, { state: 'connected', hookId: 7 })
    ingress = new ForgeWebhookIngress(ledger)
    port = (await ingress.listen({ host: '127.0.0.1', port: 0 })).port
  })

  afterEach(async () => {
    await ingress.stop()
    harness.dispose()
  })

  it('admits a delivery authenticated by the binding own secret and keeps the body', async () => {
    const reply = await post(port, `/webhooks/gitlab/${bindingId}`, SECRET)

    expect(reply.status).toBe(202)
    expect(JSON.parse(reply.text)).toEqual({ code: 'queued' })
    expect(stored()).toEqual([
      {
        binding_id: bindingId,
        instance_id: null,
        project_id: 'group/demo',
        state: 'pending',
        policy_generation: 1
      }
    ])
  })

  it('refuses the retired instance token and the retired instance path', async () => {
    const wrongToken = await post(port, `/webhooks/gitlab/${bindingId}`, 'whk-fake-token-31337')
    const wrongPath = await post(port, '/webhooks/gitlab/gitlab-main', SECRET)

    expect(wrongToken.status).toBe(401)
    expect(wrongPath.status).toBe(404)
    expect(stored()).toEqual([])
  })

  it('parks a delivery whose binding has no policy yet and keeps its body', async () => {
    ledger.ledgerContext().db.prepare('DELETE FROM project_event_policies').run()

    const reply = await post(port, `/webhooks/gitlab/${bindingId}`, SECRET)

    expect(reply.status).toBe(202)
    expect(JSON.parse(reply.text)).toEqual({ code: 'parked' })
    expect(stored()).toMatchObject([{ state: 'parked', policy_generation: null }])
  })

  it('keeps a policy-less push pending so its own item can open, and parks a note', async () => {
    ledger.ledgerContext().db.prepare('DELETE FROM project_event_policies').run()

    const push = await post(
      port,
      `/webhooks/gitlab/${bindingId}`,
      SECRET,
      'push-1',
      'Push Hook',
      PUSH_BODY
    )
    const note = await post(
      port,
      `/webhooks/gitlab/${bindingId}`,
      SECRET,
      'note-1',
      'Note Hook',
      NOTE_BODY
    )

    expect(push.status).toBe(202)
    expect(JSON.parse(push.text)).toEqual({ code: 'queued' })
    expect(note.status).toBe(202)
    expect(JSON.parse(note.text)).toEqual({ code: 'parked' })
    expect(
      ledger
        .ledgerContext()
        .db.prepare(
          `SELECT state, parked_reason, decision_state FROM webhook_deliveries ORDER BY id`
        )
        .all()
    ).toEqual([
      { state: 'pending', parked_reason: 'recorded', decision_state: 'queued' },
      { state: 'parked', parked_reason: 'awaiting-policy', decision_state: 'blocked' }
    ])
  })

  it('rejects a body whose project id is not the binding project', async () => {
    const reply = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/webhooks/gitlab/${bindingId}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-gitlab-token': SECRET,
            'x-gitlab-event': 'Merge Request Hook',
            'webhook-id': 'other-project'
          },
          agent: false
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify({ project: { id: 99 } }))
    })

    expect(reply.status).toBe(422)
    expect(stored()).toEqual([])
  })
})

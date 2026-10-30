import { afterEach, describe, expect, it } from 'vitest'
import { ForgeCredentialUnavailableError } from './forge-inbox-credentials'
import { createFakeGitlab } from './forge-inbox-gitlab-fake-server'
import { createForgeOwnerGitlabReader } from './forge-inbox-gitlab-owner-reader'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  webhookConfig,
  webhookInstance
} from './forge-inbox-webhook-test-harness'

const API_TOKEN = 'glpat-worker-api-token'

/** One instance whose only project is `projectId`; the reader is given an api-read credential. */
function createOwnerReaderRig() {
  const harness = createWebhookHarness()
  const gitlab = createFakeGitlab()
  const ledger = harness.open()
  const config = (projectId: string) =>
    webhookConfig([webhookInstance({ projects: [{ projectId, repoId: 'repo-1', enabled: true }] })])
  const apply = (next: unknown) => {
    const updated = ledger.updateConfig(ledger.getConfig().configRevision, next)
    if (!updated.ok) {
      throw new Error(`config rejected: ${updated.reason}`)
    }
  }
  apply(config(PROJECT_ID))
  const stored = ledger.setCredential({
    instanceId: INSTANCE_ID,
    kind: 'api-read',
    secret: API_TOKEN,
    expectedRevision: ledger.getConfig().configRevision
  })
  if (!stored.ok) {
    throw new Error(`api credential rejected: ${stored.reason}`)
  }
  return {
    ledger,
    gitlab,
    reconfigure: (projectId: string) => apply(config(projectId)),
    dispose: () => harness.dispose()
  }
}

type Rig = ReturnType<typeof createOwnerReaderRig>

function recordingHttp(rig: Rig) {
  const requests: { url: string; token: string | null }[] = []
  return {
    requests,
    http: {
      fetch: (url: string, init?: RequestInit) => {
        requests.push({ url, token: new Headers(init?.headers).get('private-token') })
        return rig.gitlab.fetch(url, init)
      }
    }
  }
}

function unavailableSecrets(rig: Rig): Pick<ForgeInboxLedger, 'getConfig' | 'readSecret'> {
  return {
    getConfig: () => rig.ledger.getConfig(),
    readSecret: () => {
      throw new ForgeCredentialUnavailableError()
    }
  }
}

describe('forge owner GitLab reader', () => {
  let rig: Rig
  afterEach(() => rig.dispose())

  function open(
    target = { instanceId: INSTANCE_ID, projectId: PROJECT_ID },
    ledger?: Pick<ForgeInboxLedger, 'getConfig' | 'readSecret'>
  ) {
    const { requests, http } = recordingHttp(rig)
    const made = createForgeOwnerGitlabReader(
      { ledger: ledger ?? rig.ledger, http, signal: new AbortController().signal },
      target
    )
    return { made, requests }
  }

  it('reads the configured project through the owner’s api-read credential', async () => {
    rig = createOwnerReaderRig()
    const { made, requests } = open()
    if (!made.ok) {
      throw new Error(`expected a reader, got ${made.reason}`)
    }
    await expect(made.reader.getMergeRequest(7)).resolves.toMatchObject({ ok: true })
    expect(requests).toEqual([
      {
        url: `https://gitlab.example.com/api/v4/projects/${PROJECT_ID}/merge_requests/7`,
        token: API_TOKEN
      }
    ])
  })

  it('answers project-missing without fetching when the project is not configured', async () => {
    rig = createOwnerReaderRig()
    rig.reconfigure('99')
    const { made, requests } = open()
    expect(made).toEqual({ ok: false, reason: 'project-missing' })
    expect(requests).toEqual([])
  })

  it('answers instance-missing without fetching when the instance is not configured', async () => {
    rig = createOwnerReaderRig()
    const { made, requests } = open({ instanceId: 'gitlab-absent', projectId: PROJECT_ID })
    expect(made).toEqual({ ok: false, reason: 'instance-missing' })
    expect(requests).toEqual([])
  })

  it('reads with no credential when the sealed secret is unavailable instead of throwing', async () => {
    rig = createOwnerReaderRig()
    const { made, requests } = open(
      { instanceId: INSTANCE_ID, projectId: PROJECT_ID },
      unavailableSecrets(rig)
    )
    if (!made.ok) {
      throw new Error(`expected a reader, got ${made.reason}`)
    }
    await expect(made.reader.getMergeRequest(7)).resolves.toEqual({
      ok: false,
      code: 'no-credential'
    })
    expect(requests).toEqual([])
  })
})

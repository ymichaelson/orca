import { afterEach, describe, expect, it } from 'vitest'
import { ForgeCredentialUnavailableError } from './forge-inbox-credentials'
import { createForgeOwnerGitlabReader } from './forge-inbox-gitlab-owner-reader'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { API_TOKEN, createWorkerRig, type WorkerRig } from './forge-inbox-webhook-worker-test-kit'
import { INSTANCE_ID, PROJECT_ID } from './forge-inbox-webhook-test-harness'

function recordingHttp(rig: WorkerRig) {
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

function unavailableSecrets(rig: WorkerRig): Pick<ForgeInboxLedger, 'getConfig' | 'readSecret'> {
  return {
    getConfig: () => rig.ledger.getConfig(),
    readSecret: () => {
      throw new ForgeCredentialUnavailableError()
    }
  }
}

describe('forge owner GitLab reader', () => {
  let rig: WorkerRig
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
    rig = createWorkerRig()
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
    rig = createWorkerRig()
    rig.reconfigure({ projectId: '99' })
    const { made, requests } = open()
    expect(made).toEqual({ ok: false, reason: 'project-missing' })
    expect(requests).toEqual([])
  })

  it('answers instance-missing without fetching when the instance is not configured', async () => {
    rig = createWorkerRig()
    const { made, requests } = open({ instanceId: 'gitlab-absent', projectId: PROJECT_ID })
    expect(made).toEqual({ ok: false, reason: 'instance-missing' })
    expect(requests).toEqual([])
  })

  it('reads with no credential when the sealed secret is unavailable instead of throwing', async () => {
    rig = createWorkerRig()
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

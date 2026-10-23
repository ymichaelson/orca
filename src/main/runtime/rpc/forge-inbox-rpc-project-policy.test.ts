import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fakeSecretStore,
  INSTANCE_ID,
  webhookConfig,
  webhookInstance
} from '../../forge-inbox/forge-inbox-webhook-test-harness'
import {
  CANARY,
  createForgeRpcHarness,
  errorCodeOf,
  recordOf,
  recordsOf,
  type ForgeRpcHarness
} from './forge-inbox-rpc-test-kit'

const TARGET = {
  projectId: '42',
  repoId: 'repo-1',
  enabled: true,
  model: 'gpt-fake',
  rules: 'be kind'
}
const OTHER = { projectId: '43', repoId: 'repo-2', enabled: true, rules: 'other rules' }

describe('forge inbox rpc project policy', () => {
  let harness: ForgeRpcHarness
  afterEach(() => harness.close())

  async function configured() {
    harness = await createForgeRpcHarness({ secretStore: fakeSecretStore() })
    const view = await harness.ok('forgeInbox.getConfig', {})
    const ownerHostId = String(view.ownerHostId)
    await harness.ok('forgeInbox.updateConfig', {
      ownerHostId,
      expectedRevision: Number(view.configRevision),
      config: webhookConfig([webhookInstance({ usernames: ['me'], projects: [TARGET, OTHER] })])
    })
    return ownerHostId
  }

  const projectsOf = async () => {
    const view = await harness.ok('forgeInbox.getConfig', {})
    const instance = recordsOf(recordOf(view.config).instances)[0]!
    return {
      revision: Number(view.configRevision),
      projects: recordsOf(instance.projects)
    }
  }

  const update = (
    ownerHostId: string,
    expectedRevision: number,
    patch: unknown,
    projectId = '42'
  ) =>
    harness.call(
      'forgeInbox.updateProjectPolicy',
      {
        ownerHostId,
        instanceId: INSTANCE_ID,
        projectId,
        expectedRevision,
        patch
      },
      'paired-a'
    )

  it('edits one project, clears the model with null, and leaves the other project unchanged', async () => {
    const ownerHostId = await configured()
    const before = await projectsOf()

    const response = await update(ownerHostId, before.revision, { model: null, rules: 'new rules' })

    expect(response.ok && response.result).toMatchObject({ ok: true })
    const after = await projectsOf()
    expect(after.revision).toBe(before.revision + 1)
    expect(after.projects[0]).not.toHaveProperty('model')
    expect(after.projects[0]).toMatchObject({ rules: 'new rules' })
    expect(after.projects[1]).toEqual(before.projects[1])
  })

  it('answers a stale revision with the current one and changes nothing', async () => {
    const ownerHostId = await configured()
    const before = await projectsOf()

    const response = await update(ownerHostId, before.revision - 1, { rules: 'late' })

    expect(response.ok && response.result).toMatchObject({
      ok: false,
      reason: 'stale-revision',
      configRevision: before.revision
    })
    expect(await projectsOf()).toEqual(before)
  })

  it('reports a noop as ok without bumping the revision or hinting the change feed', async () => {
    const ownerHostId = await configured()
    const before = await projectsOf()
    const hints: unknown[] = []
    harness.runtime.forgeInboxService().subscribeChangeHints((hint) => hints.push(hint))

    const response = await update(ownerHostId, before.revision, { rules: 'be kind' })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(response.ok && response.result).toEqual({
      ownerHostId,
      ok: true,
      configRevision: before.revision
    })
    expect(hints).toEqual([])
  })

  it.each([
    ['mapping', { mapping: { x: 1 } }],
    ['listener', { listener: { port: 1 } }],
    ['usernames', { usernames: ['evil'] }],
    ['a prototype key', JSON.parse('{"__proto__": {"enabled": false}}')],
    ['an oversized rules string', { rules: 'x'.repeat(1024 * 1024) }]
  ])('rejects %s without echoing values or changing the config', async (_name, patch) => {
    const ownerHostId = await configured()
    const before = await projectsOf()

    const response = await update(ownerHostId, before.revision, patch)

    expect(JSON.stringify(response)).not.toContain(CANARY)
    expect(response.ok ? response.result : errorCodeOf(response)).not.toMatchObject({ ok: true })
    expect(await projectsOf()).toEqual(before)
  })

  it('maps an invalid merged value to a message that does not echo the submitted value', async () => {
    const ownerHostId = await configured()
    const before = await projectsOf()

    const response = await update(ownerHostId, before.revision, {
      budgets: { timeoutSeconds: -1 },
      model: CANARY
    })

    expect(JSON.stringify(response)).not.toContain(CANARY)
    expect(response.ok && response.result).toMatchObject({ ok: false, reason: 'invalid-config' })
    expect(await projectsOf()).toEqual(before)
  })

  it('reports project-not-found for an unknown project', async () => {
    const ownerHostId = await configured()
    const before = await projectsOf()

    const response = await update(ownerHostId, before.revision, { enabled: false }, '999')

    expect(response.ok && response.result).toMatchObject({ ok: false, reason: 'project-not-found' })
  })
})

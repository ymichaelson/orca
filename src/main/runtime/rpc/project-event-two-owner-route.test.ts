import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { ForgeInboxLedger } from '../../forge-inbox/forge-inbox-ledger'
import {
  createOwnerFixture,
  type OwnerFixture
} from '../../forge-inbox/forge-inbox-owner-service-test-kit'
import { fakeGitlab } from '../../forge-inbox/forge-inbox-project-binding-test-fixture'
import { forgeInboxProjectBindingContextForRuntime } from '../../forge-inbox/forge-inbox-project-binding-runtime'
import { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import { FORGE_INBOX_METHODS } from './methods/forge-inbox'

const fixtures: OwnerFixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
})

function repo(id: string, path: string): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1,
    kind: 'folder',
    connectionId: null,
    projectEventGitlabProject: 'gitlab.test/group/project'
  }
}

async function owner(repos: Repo[]) {
  const fixture = createOwnerFixture()
  fixtures.push(fixture)
  const dbPath = join(fixture.root, 'forge-inbox.sqlite')
  const gitlab = fakeGitlab()
  const service = fixture.service({
    dbPath,
    projectBindingExec: gitlab.exec,
    probeProjectEventBinding: async () => ({ ok: true }),
    resolveProjectBindingContext: forgeInboxProjectBindingContextForRuntime({
      requireStore: () => ({ getRepo: (id) => repos.find((item) => item.id === id) })
    })
  })
  const runtime = new OrcaRuntimeService()
  runtime.attachForgeInboxService(service)
  await service.start()
  return {
    fixture,
    dbPath,
    ownerHostId: service.ownerHostId(),
    dispatcher: new RpcDispatcher({ runtime, methods: FORGE_INBOX_METHODS })
  }
}

async function dispatch(dispatcher: RpcDispatcher, method: string, params: unknown) {
  return dispatcher.dispatch({ id: 'test', authToken: 'test', method, params })
}

describe('project event owner dispatch', () => {
  it('keeps separate owner policies and rejects a mismatched owner', async () => {
    const rowA = repo('repo-1', '/work/a')
    const rowB = repo('repo-1', '/work/b')
    const onlyB = repo('repo-b-only', '/work/b-only')
    const a = await owner([rowA])
    const b = await owner([rowB, onlyB])
    for (const [instance, rules, repoId] of [
      [a, 'owner a rules', rowA.id],
      [b, 'owner b rules', rowB.id],
      [b, 'only b rules', onlyB.id]
    ] as const) {
      const response = await dispatch(instance.dispatcher, 'forgeInbox.updateProjectEventPolicy', {
        ownerHostId: instance.ownerHostId,
        repoId,
        expectedGeneration: 0,
        patch: { rules }
      })
      expect(response).toMatchObject({ ok: true, result: { ok: true } })
    }

    const readA = await dispatch(a.dispatcher, 'forgeInbox.getProjectEventPolicy', {
      ownerHostId: a.ownerHostId,
      repoId: rowA.id
    })
    const readB = await dispatch(b.dispatcher, 'forgeInbox.getProjectEventPolicy', {
      ownerHostId: b.ownerHostId,
      repoId: rowB.id
    })
    expect(readA).toMatchObject({
      ok: true,
      result: { policy: { rules: 'owner a rules', generation: 1 } }
    })
    expect(readB).toMatchObject({
      ok: true,
      result: { policy: { rules: 'owner b rules', generation: 1 } }
    })
    expect(readA).not.toEqual(readB)

    const mismatch = await dispatch(a.dispatcher, 'forgeInbox.getProjectEventPolicy', {
      ownerHostId: b.ownerHostId,
      repoId: onlyB.id
    })
    expect(mismatch).toMatchObject({ ok: false, error: { code: 'forge_inbox_owner_mismatch' } })

    const unknown = await dispatch(a.dispatcher, 'forgeInbox.getProjectEventPolicy', {
      ownerHostId: a.ownerHostId,
      repoId: onlyB.id
    })
    expect(unknown).toMatchObject({ ok: true, result: { policy: null } })
    const unknownWrite = await dispatch(a.dispatcher, 'forgeInbox.updateProjectEventPolicy', {
      ownerHostId: a.ownerHostId,
      repoId: onlyB.id,
      expectedGeneration: 0,
      patch: { rules: 'created on a' }
    })
    expect(unknownWrite).toMatchObject({ ok: true, result: { ok: true } })

    const updated = await dispatch(b.dispatcher, 'forgeInbox.updateProjectEventPolicy', {
      ownerHostId: b.ownerHostId,
      repoId: rowB.id,
      expectedGeneration: 1,
      patch: { rules: 'updated b' }
    })
    expect(updated).toMatchObject({ ok: true, result: { ok: true } })
    const ledgerA = ForgeInboxLedger.open(a.dbPath, {
      hostId: a.ownerHostId,
      secretStore: a.fixture.store
    })
    const ledgerB = ForgeInboxLedger.open(b.dbPath, {
      hostId: b.ownerHostId,
      secretStore: b.fixture.store
    })
    try {
      expect(ledgerA.getProjectEventPolicy(onlyB.id)).toMatchObject({
        rules: 'created on a',
        generation: 1
      })
      expect(ledgerA.getProjectEventPolicy(rowA.id)).toMatchObject({
        rules: 'owner a rules',
        generation: 1
      })
      expect(ledgerB.getProjectEventPolicy(rowB.id)).toMatchObject({
        rules: 'updated b',
        generation: 2
      })
      expect(ledgerB.getProjectEventPolicy(onlyB.id)).toMatchObject({
        rules: 'only b rules',
        generation: 1
      })
    } finally {
      ledgerA.close()
      ledgerB.close()
    }
  })
})

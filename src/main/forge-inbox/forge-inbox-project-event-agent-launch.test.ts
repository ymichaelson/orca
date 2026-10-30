import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { createForgeProjectEventAgentLaunch } from './forge-inbox-project-event-agent-launch'
import {
  emptyProbe,
  launchPorts as ports,
  MODEL,
  only,
  PROMPT,
  REPO_ID,
  REPO_PATH,
  WORKSPACE_ID
} from './forge-inbox-project-event-agent-launch-test-kit'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { ForgeInboxLedger } from './forge-inbox-ledger'

describe('project event agent launch', () => {
  let root: string
  let ledger: ForgeInboxLedger

  function configure(patch: Record<string, unknown> = {}): void {
    const current = ledger.getProjectEventPolicy(REPO_ID)
    const result = ledger.updateProjectEventPolicy(REPO_ID, current?.generation ?? 0, {
      enabled: true,
      agentId: 'claude',
      model: MODEL,
      ...patch
    })
    if (!result.ok) {
      throw new Error(`fixture policy rejected: ${result.reason}`)
    }
  }

  function seedRun(): number {
    const ctx = ledger.ledgerContext()
    ctx.db
      .prepare(
        `INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title, state,
         current_revision, head_order, activity_seq, created_at, updated_at)
         VALUES (1, ?, 'gitlab:gitlab.test', 'group/demo', 'merge_request', 7, 'Add thing',
         'opened', 1, 1, 1, ?, ?)`
      )
      .run(ctx.hostId, ctx.now(), ctx.now())
    ctx.db
      .prepare(
        `INSERT INTO item_revisions (item_id, revision, version_token, source_order, created_at)
         VALUES (1, 1, 'sha256:head', 1, ?)`
      )
      .run(ctx.now())
    const inserted = ctx.db
      .prepare(
        `INSERT INTO runs (item_id, revision, state, policy_generation, context_digest,
         analysis_kind, reason, created_at, updated_at)
         VALUES (1, 1, 'running', 1, 'sha256:head', 'merge_request', 'project-event-dispatch', ?, ?)`
      )
      .run(ctx.now(), ctx.now())
    return Number(inserted.lastInsertRowid)
  }

  function runRow(runId: number) {
    const row = ledger
      .ledgerContext()
      .db.prepare(
        'SELECT state, session_id, error, dispatch_client_message_id FROM runs WHERE id = ?'
      )
      .get(runId)
    if (!row) {
      throw new Error('expected the seeded run')
    }
    return row
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-dispatch-launch-'))
    ledger = ForgeInboxLedger.open(join(root, 'forge-inbox.sqlite'), {
      hostId: 'host-1',
      now: () => Date.now(),
      secretStore: fakeStore()
    })
    const bindingId = randomUUID()
    upsertProjectBinding(ledger.ledgerContext(), {
      bindingId,
      projectPath: '/repo',
      gitlabHost: 'gitlab.test',
      gitlabPath: 'group/demo',
      gitlabProjectId: 3,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
    })
    linkProjectEventBinding(ledger.ledgerContext(), { repoId: REPO_ID, bindingId })
    configure()
  })

  afterEach(() => {
    ledger.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('persists the submitted identity before delivery begins', async () => {
    const runId = seedRun()
    const launchPorts = ports(emptyProbe())
    const observed: { persisted: unknown; submitted: string }[] = []
    launchPorts.deliverStructuredPrompt = async (args) => {
      observed.push({
        persisted: runRow(runId).dispatch_client_message_id,
        submitted: args.clientMessageId
      })
      return 'message-fixture'
    }
    const launch = createForgeProjectEventAgentLaunch(ledger, launchPorts)
    const result = await launch({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })
    const { persisted, submitted } = only(observed)
    expect(persisted).toEqual(expect.any(String))
    expect(submitted).toBe(persisted)
    expect(result).toMatchObject({ ok: true })
  })

  it('does not send when the turn identity cannot be bound', async () => {
    const runId = seedRun()
    const probe = emptyProbe()
    const launchPorts = ports(probe)
    const createSession = launchPorts.createStructuredSession
    launchPorts.createStructuredSession = async (args) => {
      const created = await createSession(args)
      ledger
        .ledgerContext()
        .db.prepare("UPDATE runs SET dispatch_client_message_id = 'already-bound' WHERE id = ?")
        .run(runId)
      return created
    }
    const launch = createForgeProjectEventAgentLaunch(ledger, launchPorts)
    await expect(launch({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })).resolves.toEqual({
      ok: false,
      code: 'dispatch-turn-unbound'
    })
    expect(probe.delivered).toEqual([])
    expect(probe.terminal).toEqual([])
  })

  it('retains the exact identity after a delivery exception and never resends it', async () => {
    const runId = seedRun()
    const probe = emptyProbe()
    const launch = createForgeProjectEventAgentLaunch(
      ledger,
      ports(probe, {
        deliverError: new Error('post_journal_failure')
      })
    )
    await expect(launch({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })).resolves.toEqual({
      ok: false,
      code: 'unknown-outcome'
    })
    expect(runRow(runId)).toMatchObject({
      state: 'unverifiable',
      error: 'unknown-outcome',
      session_id: only(probe.created).envelope.sessionId,
      dispatch_client_message_id: only(probe.delivered).clientMessageId
    })
    expect(probe.terminal).toEqual([])
  })

  it('keeps the bound identity when delivery completes the run immediately', async () => {
    const runId = seedRun()
    const launchPorts = ports(emptyProbe())
    launchPorts.deliverStructuredPrompt = async ({ clientMessageId }) => {
      ledger
        .ledgerContext()
        .db.prepare("UPDATE runs SET state = 'succeeded' WHERE id = ?")
        .run(runId)
      return clientMessageId
    }
    const launch = createForgeProjectEventAgentLaunch(ledger, launchPorts)
    await expect(
      launch({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })
    ).resolves.toMatchObject({ ok: true })
    expect(runRow(runId)).toMatchObject({
      state: 'succeeded',
      dispatch_client_message_id: expect.any(String)
    })
  })

  it('journals the prompt into a structured session in the configured workspace', async () => {
    const runId = seedRun()
    const probe = emptyProbe()
    const launch = createForgeProjectEventAgentLaunch(ledger, ports(probe))

    const result = await launch({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })

    const created = only(probe.created)
    expect(result).toEqual({
      ok: true,
      mode: 'structured',
      sessionId: created.envelope.sessionId,
      promptOutcome: 'journaled'
    })
    expect(probe.resolved).toEqual([`id:${WORKSPACE_ID}`])
    expect(created).toMatchObject({
      worktree: `id:${WORKSPACE_ID}`,
      agent: 'claude',
      activate: false,
      caller: { callerKey: `forge-dispatch:${runId}` },
      options: { model: MODEL }
    })
    expect(created.envelope.sessionId).toMatch(/^claude_/)
    expect(only(probe.delivered)).toEqual({
      callerKey: `forge-dispatch:${runId}`,
      sessionId: created.envelope.sessionId,
      fence: 4,
      text: PROMPT,
      clientMessageId: expect.any(String)
    })
    expect(runRow(runId)).toMatchObject({
      state: 'running',
      session_id: created.envelope.sessionId,
      dispatch_client_message_id: only(probe.delivered).clientMessageId
    })
    expect(probe.watched).toEqual([{ sessionId: created.envelope.sessionId, runId }])
    expect(probe.order).toEqual(['watch', 'deliver'])
  })

  it('hands the prompt to a terminal when the user has no chat default', async () => {
    const runId = seedRun()
    const probe = emptyProbe()
    const launch = createForgeProjectEventAgentLaunch(
      ledger,
      ports(probe, {
        runtime: {
          requireStore: () => ({
            getSettings: () => ({ experimentalNativeChat: false }),
            getRepo: () => ({ path: REPO_PATH, connectionId: null })
          })
        }
      })
    )

    const result = await launch({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })

    expect(result).toEqual({
      ok: true,
      mode: 'terminal',
      sessionId: null,
      promptOutcome: 'handed-to-terminal'
    })
    expect(probe.created).toEqual([])
    expect(probe.delivered).toEqual([])
    expect(only(probe.terminal)).toEqual({
      selector: `id:${WORKSPACE_ID}`,
      agent: 'claude',
      prompt: PROMPT,
      title: 'Forge project event'
    })
    expect(runRow(runId)).toMatchObject({
      state: 'unverifiable',
      error: 'terminal-handoff',
      session_id: null,
      dispatch_client_message_id: null
    })
    expect(probe.watched).toEqual([])
  })

  it('starts a terminal after a definitive structured refusal and clears the minted session', async () => {
    const runId = seedRun()
    const probe = emptyProbe()
    const launch = createForgeProjectEventAgentLaunch(
      ledger,
      ports(probe, {
        refusal: { code: 'structured_agent_session_unsupported', message: 'no chat here' }
      })
    )

    const result = await launch({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })

    expect(result).toEqual({
      ok: true,
      mode: 'terminal',
      sessionId: null,
      promptOutcome: 'handed-to-terminal'
    })
    expect(only(probe.terminal).prompt).toBe(PROMPT)
    expect(runRow(runId)).toMatchObject({
      state: 'unverifiable',
      error: 'terminal-handoff',
      session_id: null,
      dispatch_client_message_id: null
    })
  })

  it('does not fall back to a terminal on a refusal that proves nothing', async () => {
    const runId = seedRun()
    const probe = emptyProbe()
    const launch = createForgeProjectEventAgentLaunch(
      ledger,
      ports(probe, {
        refusal: { code: 'agent_session_operation_unknown', message: 'host did not answer' }
      })
    )

    expect(await launch({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })).toEqual({
      ok: false,
      code: 'dispatch-failed'
    })
    expect(probe.terminal).toEqual([])
  })

  it('refuses to launch when the project policy has no agent', async () => {
    configure({ agentId: null })
    const runId = seedRun()
    const probe = emptyProbe()
    const launch = createForgeProjectEventAgentLaunch(ledger, ports(probe))

    expect(await launch({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })).toEqual({
      ok: false,
      code: 'dispatch-unconfigured'
    })
    expect(probe).toEqual(emptyProbe())
    expect(runRow(runId)).toMatchObject({ state: 'running', session_id: null })
  })

  it('refuses a disabled policy and ignores legacy config instances', async () => {
    configure({ enabled: false })
    ledger.updateConfig(ledger.getConfig().configRevision, {
      schemaVersion: 1,
      instances: [
        {
          id: 'gitlab-main',
          displayName: 'GitLab',
          baseUrl: 'https://gitlab.test',
          projects: [
            {
              projectId: '3',
              repoId: REPO_ID,
              workspaceId: WORKSPACE_ID,
              agentId: 'claude',
              model: MODEL,
              enabled: true,
              automaticAnalysis: false
            }
          ]
        }
      ]
    })
    const runId = seedRun()
    const probe = emptyProbe()
    expect(
      await createForgeProjectEventAgentLaunch(
        ledger,
        ports(probe)
      )({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })
    ).toEqual({ ok: false, code: 'dispatch-unconfigured' })
    expect(probe).toEqual(emptyProbe())
  })

  it('launches a repo configured only through the project policy', async () => {
    const runId = seedRun()
    const probe = emptyProbe()
    expect(ledger.getConfig().config.instances).toEqual([])
    const result = await createForgeProjectEventAgentLaunch(
      ledger,
      ports(probe)
    )({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })
    expect(result).toMatchObject({ ok: true })
    expect(only(probe.created).worktree).toBe(`id:${WORKSPACE_ID}`)
  })

  it('sends no model override for the Agent default and follows an Agent switch', async () => {
    configure({ model: null, agentId: 'codex' })
    const runId = seedRun()
    const probe = emptyProbe()
    await createForgeProjectEventAgentLaunch(
      ledger,
      ports(probe)
    )({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })
    const created = only(probe.created)
    expect(created.agent).toBe('codex')
    expect(created.options?.model).toBeUndefined()
  })

  it('refuses a policy generation that moved since the prompt was built', async () => {
    const runId = seedRun()
    const probe = emptyProbe()
    const generation = ledger.getProjectEventPolicy(REPO_ID)?.generation ?? 0
    expect(
      await createForgeProjectEventAgentLaunch(
        ledger,
        ports(probe)
      )({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT, policyGeneration: generation - 1 })
    ).toEqual({ ok: false, code: 'dispatch-unconfigured' })
    expect(probe).toEqual(emptyProbe())
  })

  it('does not surface an arbitrary thrown message as a code', async () => {
    const runId = seedRun()
    const probe = emptyProbe()
    const launchPorts = ports(probe)
    launchPorts.createStructuredSession = async () => {
      throw new Error('secret-token-123')
    }
    const launch = createForgeProjectEventAgentLaunch(ledger, launchPorts)
    expect(await launch({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })).toEqual({
      ok: false,
      code: 'dispatch-failed'
    })
  })

  it('refuses a workspace whose execution host is not this one and never launches', async () => {
    const runId = seedRun()
    const probe = emptyProbe()
    const launch = createForgeProjectEventAgentLaunch(
      ledger,
      ports(probe, {
        runtime: {
          resolveRuntimeFileTarget: async () => ({
            worktree: { path: REPO_PATH, id: WORKSPACE_ID, repoId: REPO_ID },
            executionHostId: 'ssh:builder'
          })
        }
      })
    )
    expect(await launch({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })).toEqual({
      ok: false,
      code: 'workspace-remote-unsupported'
    })
    expect(probe.created).toEqual([])
    expect(probe.terminal).toEqual([])
  })

  it('reports an ambiguous selector and a foreign repo as their own codes', async () => {
    const runId = seedRun()
    const ambiguous = createForgeProjectEventAgentLaunch(
      ledger,
      ports(emptyProbe(), {
        runtime: {
          resolveRuntimeFileTarget: async () => {
            throw new Error('selector_ambiguous')
          }
        }
      })
    )
    expect(await ambiguous({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })).toEqual({
      ok: false,
      code: 'workspace-ambiguous'
    })
    const foreign = createForgeProjectEventAgentLaunch(
      ledger,
      ports(emptyProbe(), {
        runtime: {
          resolveRuntimeFileTarget: async () => ({
            worktree: { path: REPO_PATH, id: 'other::/x', repoId: 'other' },
            executionHostId: LOCAL_EXECUTION_HOST_ID
          })
        }
      })
    )
    expect(await foreign({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })).toEqual({
      ok: false,
      code: 'workspace-repo-mismatch'
    })
  })

  it('refuses a terminal prompt too large for a command line instead of truncating it', async () => {
    const runId = seedRun()
    const probe = emptyProbe()
    const launch = createForgeProjectEventAgentLaunch(
      ledger,
      ports(probe, {
        runtime: {
          requireStore: () => ({
            getSettings: () => ({ experimentalNativeChat: false }),
            getRepo: () => ({ path: REPO_PATH, connectionId: null })
          })
        }
      })
    )
    expect(
      await launch({ itemId: 1, repoId: REPO_ID, runId, prompt: 'x'.repeat(64 * 1024) })
    ).toEqual({ ok: false, code: 'dispatch-prompt-too-large-for-terminal' })
    expect(probe.terminal).toEqual([])
  })

  it('refuses a repo that is missing or hosted remotely', async () => {
    const runId = seedRun()
    for (const [getRepo, code] of [
      [() => undefined, 'workspace-unresolved'],
      [() => ({ path: REPO_PATH, connectionId: 'ssh-1' }), 'workspace-remote-unsupported']
    ] as const) {
      const probe = emptyProbe()
      const launch = createForgeProjectEventAgentLaunch(
        ledger,
        ports(probe, {
          runtime: {
            requireStore: () => ({ getSettings: () => ({ experimentalNativeChat: true }), getRepo })
          }
        })
      )
      expect(await launch({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })).toEqual({
        ok: false,
        code
      })
      expect(probe).toEqual(emptyProbe())
    }
  })

  it('treats a workspace the host cannot resolve as unresolved', async () => {
    const runId = seedRun()
    const probe = emptyProbe()
    const launch = createForgeProjectEventAgentLaunch(
      ledger,
      ports(probe, {
        runtime: {
          resolveRuntimeFileTarget: async () => {
            throw new Error('workspace is gone')
          }
        }
      })
    )

    expect(await launch({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })).toEqual({
      ok: false,
      code: 'workspace-unresolved'
    })
    expect(probe.created).toEqual([])
    expect(probe.terminal).toEqual([])
  })

  it('leaves an undelivered prompt unverifiable once a send was attempted', async () => {
    const runId = seedRun()
    const launch = createForgeProjectEventAgentLaunch(
      ledger,
      ports(emptyProbe(), { messageId: null })
    )

    expect(await launch({ itemId: 1, repoId: REPO_ID, runId, prompt: PROMPT })).toEqual({
      ok: false,
      code: 'unknown-outcome'
    })
    expect(runRow(runId)).toMatchObject({ state: 'unverifiable', error: 'unknown-outcome' })
  })

  it('disposes the run watch it was given', () => {
    let disposed = 0
    const launchPorts = ports(emptyProbe())
    launchPorts.runWatch = {
      watch: () => {},
      dispose: () => void (disposed += 1),
      isDisposed: () => false
    }
    createForgeProjectEventAgentLaunch(ledger, launchPorts).dispose?.()
    expect(disposed).toBe(1)
  })

  it('treats a terminal launch with no prompt text as undelivered', async () => {
    const runId = seedRun()
    const probe = emptyProbe()
    const launch = createForgeProjectEventAgentLaunch(
      ledger,
      ports(probe, {
        runtime: {
          requireStore: () => ({
            getSettings: () => ({ experimentalNativeChat: false }),
            getRepo: () => ({ path: REPO_PATH, connectionId: null })
          })
        }
      })
    )

    expect(await launch({ itemId: 1, repoId: REPO_ID, runId, prompt: '' })).toEqual({
      ok: false,
      code: 'dispatch-prompt-undelivered'
    })
    expect(only(probe.terminal)).toEqual({
      selector: `id:${WORKSPACE_ID}`,
      agent: 'claude',
      prompt: '',
      title: 'Forge project event'
    })
  })
})

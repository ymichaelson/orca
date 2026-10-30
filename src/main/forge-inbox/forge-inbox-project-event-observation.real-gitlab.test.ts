import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { glabExecFileAsync } from '../git/command-runner/glab-exec-file'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import type { ProjectEventActionClaim } from './forge-inbox-project-event-action'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { observeProjectEventBindingHead } from './forge-inbox-project-event-observation'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

// Why gated: this reads a real GitLab through the host's own glab login, so it needs a live
// instance; a credential-less CI run must skip rather than pass on a fixture.
const ENABLED = process.env.ORCA_E2E_REAL_GITLAB === '1'
const HOST = process.env.ORCA_E2E_GITLAB_HOST ?? 'gitlab.test:8929'

type Project = {
  id: number
  path: string
  branch: string
  iid: number
  headSha: string
  title: string
}

type Fixture = {
  cwd: string
  project: Project
  ctx: ForgeLedgerContext
  claim: ProjectEventActionClaim
}

let fixture: Fixture | undefined

function started(): Fixture {
  if (!fixture) {
    throw new Error('the real GitLab fixture never started')
  }
  return fixture
}

/** One glab API call as the host would make it; the ported host travels as GITLAB_HOST. */
async function api<T>(
  cwd: string,
  method: string,
  route: string,
  schema: z.ZodType<T>,
  body?: unknown
): Promise<T> {
  let bodyPath: string | null = null
  try {
    const args = ['api', '--method', method, '--hostname', HOST, route]
    if (body !== undefined) {
      bodyPath = join(cwd, `glab-body-${randomUUID()}.json`)
      writeFileSync(bodyPath, JSON.stringify(body))
      args.push('--input', bodyPath)
    }
    const result = await glabExecFileAsync(args, { cwd })
    const parsed = schema.safeParse(JSON.parse(result.stdout))
    if (!parsed.success) {
      throw new Error(`unexpected glab response for ${route}: ${parsed.error.message}`)
    }
    return parsed.data
  } finally {
    if (bodyPath !== null) {
      unlinkSync(bodyPath)
    }
  }
}

const projectSchema = z.object({
  id: z.number(),
  path_with_namespace: z.string(),
  default_branch: z.string()
})
const commitSchema = z.object({ id: z.string() })
const mergeRequestSchema = z.object({ iid: z.number() })
const headSchema = z.object({
  sha: z.string().nullable(),
  diff_refs: z.object({ head_sha: z.string() }).nullable()
})

async function createProject(cwd: string): Promise<Project> {
  const project = await api(cwd, 'POST', 'projects', projectSchema, {
    name: `orca-observation-${Date.now()}`,
    initialize_with_readme: true,
    visibility: 'private'
  })
  const title = 'Observation probe merge request'
  const branch = `probe-${randomUUID().slice(0, 8)}`
  const commit = await api(cwd, 'POST', `projects/${project.id}/repository/commits`, commitSchema, {
    branch,
    start_branch: project.default_branch,
    commit_message: 'Probe change',
    actions: [{ action: 'create', file_path: 'probe.txt', content: 'probe\n' }]
  })
  const created = await api(
    cwd,
    'POST',
    `projects/${project.id}/merge_requests`,
    mergeRequestSchema,
    {
      source_branch: branch,
      target_branch: project.default_branch,
      title,
      description: 'Created to prove the observation path reads real GitLab data.'
    }
  )
  const headSha = await readHeadSha(cwd, project.id, created.iid)
  if (headSha !== commit.id) {
    throw new Error(
      `the merge request head ${headSha} is not the commit ${commit.id} it was opened on`
    )
  }
  return {
    id: project.id,
    path: project.path_with_namespace,
    branch,
    iid: created.iid,
    headSha,
    title
  }
}

/** GitLab computes an MR diff asynchronously, so the head is read once it lands. */
async function readHeadSha(cwd: string, projectId: number, iid: number): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const mergeRequest = await api(
      cwd,
      'GET',
      `projects/${projectId}/merge_requests/${iid}`,
      headSchema
    )
    const sha = mergeRequest.diff_refs?.head_sha ?? mergeRequest.sha
    if (sha) {
      return sha
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('the probe merge request never reported a head commit')
}

describe.skipIf(!ENABLED)('observing a project event against a real GitLab', () => {
  beforeAll(async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'forge-real-gitlab-'))
    let project: Project | undefined
    try {
      project = await createProject(cwd)
      const opened = openForgeInboxDatabase(join(cwd, 'forge-inbox.sqlite'), 'host-real')
      const ctx: ForgeLedgerContext = {
        db: opened.db,
        hostId: opened.hostId,
        now: () => Date.now(),
        // Why: observation reads GitLab through glab, never through a stored credential.
        secretStore: () => {
          throw new Error('the observation path must not need the secret store')
        }
      }
      const bindingId = randomUUID()
      upsertProjectBinding(ctx, {
        bindingId,
        projectPath: cwd,
        gitlabHost: HOST,
        gitlabPath: project.path,
        gitlabProjectId: project.id,
        callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
      })
      linkProjectEventBinding(ctx, { repoId: 'repo-real', bindingId })
      updateProjectEventPolicy(ctx, {
        repoId: 'repo-real',
        expectedGeneration: 0,
        patch: { enabled: true }
      })
      const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
        bindingId,
        projectPath: project.path,
        policyGeneration: 1,
        policyEnabled: true,
        eventKind: 'Merge Request Hook',
        dedupeKey: `real-${randomUUID()}`,
        correlation: { eventUuid: null, configUuid: null },
        body: Buffer.from(
          JSON.stringify({
            object_kind: 'merge_request',
            project: { id: project.id },
            merge_request: { iid: project.iid, title: project.title, state: 'opened' },
            object_attributes: { action: 'update' }
          })
        )
      })
      if (!admitted.ok) {
        throw new Error(`the fixture delivery was refused: ${admitted.reason}`)
      }
      const token = randomUUID()
      const startedAt = ctx.now()
      const inserted = ctx.db
        .prepare(
          `INSERT INTO project_event_decisions (host_id, delivery_id, policy_generation, provider,
             model, action, confidence, input_tokens, output_tokens, decided_at,
             action_state, action_token, action_started_at)
           VALUES (?, ?, 1, 'jev', 'jev-1', 'dispatch_agent', 0.8, 10, 2, ?, 'processing', ?, ?)`
        )
        .run(ctx.hostId, admitted.deliveryId, startedAt, token, startedAt)
      ctx.db
        .prepare(
          `UPDATE webhook_deliveries SET decision_state = 'processing', decision_token = ?,
             decision_started_at = ? WHERE id = ?`
        )
        .run(token, startedAt, admitted.deliveryId)
      fixture = {
        cwd,
        project,
        ctx,
        claim: {
          decisionId: Number(inserted.lastInsertRowid),
          deliveryId: admitted.deliveryId,
          action: 'dispatch_agent',
          itemId: null,
          token,
          startedAt,
          bindingId,
          repoId: 'repo-real',
          generation: 1
        }
      }
    } catch (error) {
      // Why: a failed fixture must not leave a project behind on the real GitLab.
      if (project) {
        await api(cwd, 'DELETE', `projects/${project.id}`, z.unknown()).catch(() => undefined)
      }
      rmSync(cwd, { recursive: true, force: true })
      throw error
    }
  }, 180_000)

  afterAll(async () => {
    if (fixture) {
      await api(fixture.cwd, 'DELETE', `projects/${fixture.project.id}`, z.unknown()).catch(
        () => undefined
      )
      fixture.ctx.db.close()
      rmSync(fixture.cwd, { recursive: true, force: true })
    }
  }, 60_000)

  it('stores the head, title and state the real GitLab reports', async () => {
    const { ctx, project, claim } = started()

    const observed = await observeProjectEventBindingHead(ctx, claim)

    expect(observed).toMatchObject({
      ok: true,
      revision: 1,
      complete: true,
      newRevision: true,
      kind: 'merge_request',
      iid: project.iid,
      sha: project.headSha,
      title: project.title,
      state: 'opened'
    })
    expect(ctx.db.prepare('SELECT title, state FROM items').all()).toEqual([
      { title: project.title, state: 'opened' }
    ])
  }, 180_000)

  it('treats the same observed head as a duplicate revision', async () => {
    const { ctx, project, claim } = started()

    const again = await observeProjectEventBindingHead(ctx, claim)

    expect(again).toMatchObject({ ok: true, newRevision: false, sha: project.headSha })
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM item_revisions').get()).toEqual({ n: 1 })
  }, 180_000)
})

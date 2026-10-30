import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GlabExecOptions } from '../git/command-runner/glab-exec-file'
import { createForgeCommentBroker } from './forge-inbox-comment-broker'
import {
  hashForgeCommentDraft,
  parseForgeCommentDraft,
  type ForgeCommentTarget
} from './forge-inbox-comment-draft'
import { approveForgeComment, createForgeCommentProposal } from './forge-inbox-comment-proposal'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { createWebhookHarness, type WebhookHarness } from './forge-inbox-webhook-test-harness'

const HOST = 'gitlab.test'
const PATH = 'group/project'
const SCOPE = { instanceId: `gitlab:${HOST}` }
const HEAD = 'a'.repeat(40)
const SIGNAL = new AbortController().signal

type ExecCall = { args: string[]; options?: GlabExecOptions }

function noteResponse(id: number): { stdout: string; stderr: string } {
  return {
    stdout: `HTTP/1.1 201 Created\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ id })}`,
    stderr: ''
  }
}

function fakeGlab() {
  const calls: ExecCall[] = []
  return {
    calls,
    exec: async (args: string[], options?: GlabExecOptions) => {
      calls.push({ args, options })
      return noteResponse(701)
    }
  }
}

describe('forge comment broker with a project binding', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
  })
  afterEach(() => {
    harness.dispose()
  })

  function bind(bindingId: string, projectId: number, path = PATH): void {
    upsertProjectBinding(ledger.ledgerContext(), {
      bindingId,
      projectPath: '/repos/project',
      gitlabHost: HOST,
      gitlabPath: path,
      gitlabProjectId: projectId,
      callbackUrl: 'http://127.0.0.1:1/forge'
    })
  }

  function approvedComment(): { proposalId: number; hash: string } {
    const observed = ledger.ingestObservation(
      {
        hostId: ledger.hostId,
        ...SCOPE,
        projectId: PATH,
        kind: 'merge_request',
        iid: 7,
        dedupeKey: 'binding-1',
        eventKind: 'merge_request.review_requested',
        payload: {},
        versionToken: 'sha256:v1',
        queueRun: { reason: 'review-request' }
      },
      ledger.getConfig().configRevision,
      0
    )
    if (!observed.ok || observed.duplicate || observed.runId === null) {
      throw new Error(`unexpected observation outcome ${JSON.stringify(observed)}`)
    }
    ledger.transitionRun(observed.runId, { to: 'running' })
    const run = ledger.getRun(observed.runId)
    if (!run) {
      throw new Error('run vanished')
    }
    const target: ForgeCommentTarget = {
      instanceId: SCOPE.instanceId,
      projectId: PATH,
      kind: 'merge_request',
      iid: 7
    }
    const created = createForgeCommentProposal(
      { ledger },
      {
        scope: SCOPE,
        runId: run.id,
        expectedGeneration: run.generation,
        draft: { target, headSha: HEAD, body: 'Looks good to me.' }
      }
    )
    if (!created.ok) {
      throw new Error(`proposal rejected: ${created.reason}`)
    }
    return { proposalId: created.proposal.id, hash: created.hash }
  }

  async function approve(proposalId: number): Promise<void> {
    const proposal = ledger.getProposal(proposalId)
    const draft = proposal === null ? null : parseForgeCommentDraft(proposal.body)
    if (proposal === null || draft === null) {
      throw new Error('proposal vanished')
    }
    const approved = await approveForgeComment(
      { ledger, readHead: async () => ({ ok: true, sha: HEAD }) },
      {
        scope: SCOPE,
        proposalId,
        expectedHash: hashForgeCommentDraft(draft),
        expectedRevision: proposal.revision,
        expectedPolicyGeneration: proposal.policyGeneration
      },
      SIGNAL
    )
    if (!approved.ok) {
      throw new Error(`approval refused: ${approved.reason}`)
    }
  }

  it('publishes through glab with the binding destination and no stored credential', async () => {
    bind('6f1e6b3a-0a5c-4a43-9a1e-2f4b0d7c9e11', 31)
    const comment = approvedComment()
    await approve(comment.proposalId)
    const glab = fakeGlab()
    const http = {
      fetch: async () => {
        throw new Error('the binding path must not use instance credentials')
      }
    }
    const broker = createForgeCommentBroker({ ledger, http, glabExec: glab.exec })

    const result = await broker.publish(
      { scope: SCOPE, expectedHash: comment.hash, proposalId: comment.proposalId },
      SIGNAL
    )

    expect(result).toMatchObject({ kind: 'published', noteId: 701 })
    expect(glab.calls).toHaveLength(1)
    expect(glab.calls[0]?.args).toEqual([
      'api',
      '-i',
      '--hostname',
      HOST,
      '--method',
      'POST',
      'projects/31/merge_requests/7/notes',
      '--input',
      '-'
    ])
    expect(glab.calls[0]?.options?.cwd).toBe('/repos/project')
    expect(glab.calls[0]?.args.join(' ')).not.toContain('glpat-')
  })

  it('reads the head through glab for a binding target', async () => {
    bind('6f1e6b3a-0a5c-4a43-9a1e-2f4b0d7c9e11', 31)
    const glab = fakeGlab()
    const broker = createForgeCommentBroker({
      ledger,
      http: {
        fetch: async () => {
          throw new Error('the binding path must not use instance credentials')
        }
      },
      glabExec: async (args, options) => {
        glab.calls.push({ args, options })
        return {
          stdout: `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ diff_refs: { head_sha: HEAD } })}`,
          stderr: ''
        }
      }
    })

    await expect(
      broker.readHead(
        { instanceId: SCOPE.instanceId, projectId: PATH, kind: 'merge_request', iid: 7 },
        SIGNAL
      )
    ).resolves.toEqual({ ok: true, sha: HEAD })
    expect(glab.calls[0]?.args).toContain('projects/31/merge_requests/7')
  })

  it('refuses a binding target whose path has no binding instead of falling back', async () => {
    const comment = approvedComment()
    await approve(comment.proposalId)
    const glab = fakeGlab()
    const broker = createForgeCommentBroker({
      ledger,
      http: {
        fetch: async () => {
          throw new Error('unreachable')
        }
      },
      glabExec: glab.exec
    })

    await expect(
      broker.publish(
        { scope: SCOPE, expectedHash: comment.hash, proposalId: comment.proposalId },
        SIGNAL
      )
    ).resolves.toMatchObject({ kind: 'failed', reason: 'no-credential' })
    expect(glab.calls).toEqual([])
  })

  it('refuses an ambiguous path rather than choosing a binding', async () => {
    bind('6f1e6b3a-0a5c-4a43-9a1e-2f4b0d7c9e11', 31)
    bind('9c2d4f18-3b7a-4c55-8e60-1a9d2b3c4e5f', 32)
    const comment = approvedComment()
    await approve(comment.proposalId)
    const glab = fakeGlab()
    const broker = createForgeCommentBroker({
      ledger,
      http: {
        fetch: async () => {
          throw new Error('unreachable')
        }
      },
      glabExec: glab.exec
    })

    await expect(
      broker.publish(
        { scope: SCOPE, expectedHash: comment.hash, proposalId: comment.proposalId },
        SIGNAL
      )
    ).resolves.toMatchObject({ kind: 'failed', reason: 'no-credential' })
    expect(glab.calls).toEqual([])
  })

  it('never reaches instance config or credentials for a binding target without a binding', async () => {
    const reached: string[] = []
    const spied = new Proxy(ledger, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (
          (property === 'getConfig' || property === 'readSecret') &&
          typeof value === 'function'
        ) {
          return (...args: unknown[]) => {
            reached.push(String(property))
            return value.apply(target, args)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const comment = approvedComment()
    await approve(comment.proposalId)
    reached.length = 0
    const broker = createForgeCommentBroker({
      ledger: spied,
      http: {
        fetch: async () => {
          throw new Error('unreachable')
        }
      }
    })

    await expect(
      broker.publish(
        { scope: SCOPE, expectedHash: comment.hash, proposalId: comment.proposalId },
        SIGNAL
      )
    ).resolves.toMatchObject({ kind: 'failed', reason: 'no-credential' })
    await expect(
      broker.readHead(
        { instanceId: SCOPE.instanceId, projectId: PATH, kind: 'merge_request', iid: 7 },
        SIGNAL
      )
    ).resolves.toEqual({ ok: false, code: 'no-credential' })
    expect(reached).toEqual([])
  })
})

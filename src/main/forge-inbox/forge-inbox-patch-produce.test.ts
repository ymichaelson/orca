import { describe, expect, it } from 'vitest'
import { refuse } from '../../shared/agent-session-wire'
import type { ForgeItem, ForgeRun } from '../../shared/forge-inbox-types'
import type { GitlabApiReader } from './forge-inbox-gitlab-api-client'
import { buildForgePatchDraft, sha256OfContent } from './forge-inbox-patch-draft'
import type {
  ForgePatchRequestFinishInput,
  ForgePatchRequestFinishResult,
  ForgePatchRequestFailureReason
} from './forge-inbox-patch-request-completion'
import type {
  ForgePatchRequest,
  ForgePatchRequestClaimInput,
  ForgePatchRequestClaimResult
} from './forge-inbox-patch-requests'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeProtectedSessionRecord } from './forge-inbox-protected-session-binding'
import { createForgeInboxPatchProducer } from './forge-inbox-patch-produce'
import { protectedTurnHarness, TURN_SESSION } from './forge-inbox-protected-turn-test-harness'
import {
  INSTANCE_ID,
  PROJECT_ID,
  RUN_ID,
  REQUEST_ID,
  PROPOSAL_ID,
  HEAD,
  HEAD_MOVED,
  OLD_CONTENT,
  NEW_CONTENT,
  SUBJECT,
  CANDIDATE,
  CONFIG,
  RUN,
  ITEM,
  request,
  record,
  mergeRequest,
  diff,
  BLOB
} from './forge-inbox-patch-produce-test-kit'

function reader(overrides: Partial<GitlabApiReader> = {}): GitlabApiReader {
  const failed = async () => ({ ok: false as const, code: 'network' as const })
  return {
    getMergeRequest: async () => ({ ok: true, data: mergeRequest(), complete: true }),
    getMergeRequestDiffs: async () => ({ ok: true, data: [diff()], complete: true }),
    listMergeRequestNotes: failed,
    listIssueNotes: failed,
    getPipeline: failed,
    getIssue: failed,
    listRepositoryTree: async () => ({
      ok: true,
      data: [
        { id: BLOB.oid, name: 'feature.ts', type: 'blob', path: 'src/feature.ts', mode: '100644' }
      ],
      complete: true
    }),
    getRepositoryFile: async () => ({ ok: true, data: OLD_CONTENT, complete: true }),
    getRepositoryCommit: failed,
    getRepositoryBranchHead: async (branch) => ({
      ok: true,
      data: { branch, sha: HEAD },
      complete: true
    }),
    getProjectRepository: failed,
    getCurrentUser: async () => ({
      ok: true,
      data: { name: 'Bot', username: 'bot', email: null, commit_email: null },
      complete: true
    }),
    ...overrides
  }
}

function movedReader(): GitlabApiReader {
  const base = reader()
  let mergeRequestCalls = 0
  let branchHeadCalls = 0
  return {
    ...base,
    getMergeRequest: async (iid) => {
      mergeRequestCalls += 1
      const sha = mergeRequestCalls >= 3 ? HEAD_MOVED : HEAD
      return {
        ok: true,
        data: mergeRequest({
          iid,
          sha,
          diff_refs: { base_sha: 'b'.repeat(40), head_sha: sha, start_sha: 'b'.repeat(40) }
        }),
        complete: true
      }
    },
    getRepositoryBranchHead: async (branch) => {
      branchHeadCalls += 1
      return {
        ok: true,
        data: { branch, sha: branchHeadCalls >= 3 ? HEAD_MOVED : HEAD },
        complete: true
      }
    }
  }
}

function movedBeforeSendReader(): GitlabApiReader {
  const base = reader()
  let branchHeadCalls = 0
  return {
    ...base,
    getRepositoryBranchHead: async (branch) => {
      branchHeadCalls += 1
      return {
        ok: true,
        data: { branch, sha: branchHeadCalls >= 2 ? HEAD_MOVED : HEAD },
        complete: true
      }
    }
  }
}

function throwingThirdVerifyReader(): GitlabApiReader {
  const base = reader()
  let mergeRequestCalls = 0
  return {
    ...base,
    getMergeRequest: async (iid) => {
      mergeRequestCalls += 1
      if (mergeRequestCalls >= 3) {
        throw new Error('third verify failed')
      }
      return { ok: true, data: mergeRequest({ iid }), complete: true }
    }
  }
}

type FenceResult = { ok: true } | { ok: false; reason: ForgePatchRequestFailureReason }

type FakeLedger = Pick<
  ForgeInboxLedger,
  | 'claimPatchRequest'
  | 'getPatchRequest'
  | 'finishPatchRequest'
  | 'getRun'
  | 'getItem'
  | 'getConfig'
> & { checkPatchRequestFences: (request: ForgePatchRequest) => FenceResult }

function finishResult(
  input: ForgePatchRequestFinishInput,
  current: ForgePatchRequest
): ForgePatchRequestFinishResult {
  if (input.outcome.kind === 'success') {
    return {
      kind: 'completed',
      request: { ...current, state: 'succeeded', proposalId: PROPOSAL_ID, reasonCode: null },
      proposal: {
        id: PROPOSAL_ID,
        runId: current.runId,
        itemId: current.itemId,
        revision: current.revision,
        policyGeneration: current.policyGeneration,
        status: 'pending',
        body: input.outcome.draft,
        createdAt: 2,
        resolvedAt: null
      }
    }
  }
  return {
    kind: 'completed',
    request: {
      ...current,
      state: input.outcome.kind === 'unverifiable' ? 'unverifiable' : 'failed',
      reasonCode: input.outcome.reason
    },
    proposal: null
  }
}

type LedgerOptions = {
  claim?: ForgePatchRequestClaimResult
  fences?: () => FenceResult
  run?: ForgeRun | null
  item?: ForgeItem | null
  finish?: (
    input: ForgePatchRequestFinishInput,
    current: ForgePatchRequest
  ) => ForgePatchRequestFinishResult
  finishThrows?: boolean
}

function ledgerWith(options: LedgerOptions = {}) {
  const claimCalls: ForgePatchRequestClaimInput[] = []
  const finishCalls: ForgePatchRequestFinishInput[] = []
  let current =
    options.claim !== undefined && options.claim.kind !== 'refused'
      ? options.claim.request
      : request()
  const ledger: FakeLedger = {
    claimPatchRequest(input) {
      claimCalls.push(input)
      return options.claim ?? { kind: 'claimed', request: current }
    },
    getPatchRequest() {
      return current
    },
    checkPatchRequestFences() {
      return options.fences?.() ?? { ok: true }
    },
    finishPatchRequest(input) {
      finishCalls.push(input)
      if (options.finishThrows) {
        throw new Error('finish failed')
      }
      const result = options.finish ? options.finish(input, current) : finishResult(input, current)
      if (result.kind === 'completed') {
        current = result.request
      }
      return result
    },
    getRun() {
      return options.run === undefined ? RUN : options.run
    },
    getItem() {
      return options.item === undefined ? ITEM : options.item
    },
    getConfig() {
      return CONFIG
    }
  }
  return { ledger, claimCalls, finishCalls }
}

const PRODUCE_REQUEST = {
  scope: { instanceId: INSTANCE_ID },
  callerKey: 'client-1',
  operationId: 'op-1',
  runId: RUN_ID,
  message: 'Please update the feature',
  paths: [] as const
}

type ThrowingDependency = 'readRecord' | 'openReader' | 'ensureHost' | 'send'

/** Throws after the real send is recorded, so the host still proves one attempt happened. */
function throwingSend(port: ReturnType<typeof protectedTurnHarness>['port']) {
  return {
    ...port,
    send: async (...args: Parameters<typeof port.send>) => {
      await port.send(...args)
      throw new Error('send failed')
    }
  }
}

function harness(
  options: {
    ledger?: LedgerOptions
    records?: (ForgeProtectedSessionRecord | null)[]
    reader?: GitlabApiReader | null
    reply?: string
    throwing?: ThrowingDependency
    configureHost?: (host: ReturnType<typeof protectedTurnHarness>) => void
  } = {}
) {
  const { ledger, claimCalls, finishCalls } = ledgerWith(options.ledger)
  const host = protectedTurnHarness()
  host.reply = options.reply ?? CANDIDATE
  options.configureHost?.(host)
  const records = [...(options.records ?? [record()])]
  const calls = { openReader: 0, ensureHost: 0, readRecord: 0 }
  const readerCalls: { target: { instanceId: string; projectId: string }; signal: AbortSignal }[] =
    []
  const producer = createForgeInboxPatchProducer({
    ledger,
    openReader: async (target, signal) => {
      if (options.throwing === 'openReader') {
        throw new Error('openReader failed')
      }
      calls.openReader += 1
      readerCalls.push({ target, signal })
      return options.reader === undefined ? reader() : options.reader
    },
    ensureHost: async () => {
      if (options.throwing === 'ensureHost') {
        throw new Error('ensureHost failed')
      }
      calls.ensureHost += 1
      return options.throwing === 'send' ? throwingSend(host.port) : host.port
    },
    readRecord: async () => {
      if (options.throwing === 'readRecord') {
        throw new Error('readRecord failed')
      }
      calls.readRecord += 1
      const next = records.length > 1 ? records.shift() : records[0]
      return next ?? null
    }
  })
  return { producer, host, calls, readerCalls, claimCalls, finishCalls }
}

function sentPrompt(
  send: Parameters<ReturnType<typeof protectedTurnHarness>['port']['send']>
): string {
  const body = send[1].body
  if (body.kind !== 'message') {
    throw new Error('expected a message body')
  }
  const block = body.blocks[0]
  if (block?.type !== 'text') {
    throw new Error('expected a text block')
  }
  return block.text
}

describe('forge patch producer', () => {
  it('produces one proposal from one protected turn and settles it', async () => {
    const { producer, host, claimCalls, finishCalls } = harness()
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'proposal',
      proposalId: PROPOSAL_ID,
      requestId: REQUEST_ID
    })

    expect(claimCalls[0]).toMatchObject({
      callerKey: 'client-1',
      operationId: 'op-1',
      runId: RUN_ID,
      intent: { message: 'Please update the feature', paths: [] }
    })
    expect(host.sends).toHaveLength(1)
    expect(host.sends[0]?.[0]).toEqual({ callerKey: `forge-propose-patch:${TURN_SESSION}` })
    const send = host.sends[0]
    if (!send) {
      throw new Error('expected one protected send')
    }
    const prompt = sentPrompt(send)
    expect(prompt).toContain('Please update the feature')
    expect(prompt).toContain('src/feature.ts')
    expect(prompt).toContain(OLD_CONTENT)

    const expected = buildForgePatchDraft({
      target: { instanceId: INSTANCE_ID, projectId: PROJECT_ID },
      baseSha: HEAD,
      branch: 'feature/work',
      operations: [
        {
          op: 'update',
          path: 'src/feature.ts',
          baseSha256: sha256OfContent(OLD_CONTENT),
          content: NEW_CONTENT,
          resultSha256: sha256OfContent(NEW_CONTENT)
        }
      ]
    })
    if (!expected.ok) {
      throw new Error(`expected draft rejected: ${expected.reason}`)
    }
    expect(finishCalls).toHaveLength(1)
    expect(finishCalls[0]?.outcome).toEqual({
      kind: 'success',
      draft: expected.draft,
      expectedDraftHash: expected.hash
    })
  })

  it('opens the reader for the item’s own instance and project under the caller’s signal', async () => {
    const { producer, readerCalls } = harness()
    const controller = new AbortController()
    await expect(producer(PRODUCE_REQUEST, controller.signal)).resolves.toMatchObject({
      kind: 'proposal'
    })
    expect(readerCalls).toHaveLength(1)
    expect(readerCalls[0]?.target).toEqual({ instanceId: INSTANCE_ID, projectId: PROJECT_ID })
    expect(readerCalls[0]?.signal).toBe(controller.signal)
  })

  it('replays a terminal claim without touching a reader or the host', async () => {
    const { producer, host, calls, finishCalls } = harness({
      ledger: {
        claim: {
          kind: 'terminal',
          request: request({ state: 'succeeded', proposalId: PROPOSAL_ID })
        }
      }
    })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'proposal',
      proposalId: PROPOSAL_ID,
      requestId: REQUEST_ID
    })
    expect(calls).toEqual({ openReader: 0, ensureHost: 0, readRecord: 0 })
    expect(host.sends).toHaveLength(0)
    expect(finishCalls).toHaveLength(0)
  })

  it('replays an in-progress claim without starting another turn', async () => {
    const { producer, host, calls } = harness({
      ledger: { claim: { kind: 'in-progress', request: request() } }
    })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'in-progress'
    })
    expect(calls).toEqual({ openReader: 0, ensureHost: 0, readRecord: 0 })
    expect(host.sends).toHaveLength(0)
  })

  it('replays a refused claim without touching a reader or the host', async () => {
    const { producer, host, calls } = harness({
      ledger: { claim: { kind: 'refused', reason: 'revision-stale' } }
    })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'refused',
      reason: 'revision-stale'
    })
    expect(calls).toEqual({ openReader: 0, ensureHost: 0, readRecord: 0 })
    expect(host.sends).toHaveLength(0)
  })

  it('settles an unknown turn as unverifiable without a second send', async () => {
    const { producer, host, finishCalls } = harness({
      configureHost: (host) => {
        host.state = 'pending'
      }
    })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'unverifiable',
      reason: 'unknown-outcome'
    })
    expect(host.sends).toHaveLength(1)
    expect(finishCalls[0]?.outcome).toEqual({ kind: 'unverifiable', reason: 'unknown-outcome' })
  })

  it('settles a refused send as a producer failure', async () => {
    const { producer, host, finishCalls } = harness({
      configureHost: (host) => {
        host.refusal = refuse(
          'agent_session_operation_invalid',
          { reason: 'operationIdInvalid' },
          'invalid'
        )
      }
    })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'failed',
      reason: 'producer-failed'
    })
    expect(host.sends).toHaveLength(0)
    expect(finishCalls[0]?.outcome).toEqual({ kind: 'failed', reason: 'producer-failed' })
  })

  it('settles an unparseable reply as draft-invalid', async () => {
    const { producer, host, finishCalls } = harness({ reply: 'not a patch' })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'failed',
      reason: 'draft-invalid'
    })
    expect(host.sends).toHaveLength(1)
    expect(finishCalls[0]?.outcome).toEqual({ kind: 'failed', reason: 'draft-invalid' })
  })

  it('settles a branch head that moved after the model as target-mismatch', async () => {
    const { producer, host, finishCalls } = harness({ reader: movedReader() })
    await expect(
      producer({ ...PRODUCE_REQUEST, paths: ['src/feature.ts'] }, new AbortController().signal)
    ).resolves.toEqual({ kind: 'failed', reason: 'target-mismatch' })
    expect(host.sends).toHaveLength(1)
    expect(finishCalls[0]?.outcome).toEqual({ kind: 'failed', reason: 'target-mismatch' })
  })

  it('settles a branch head that moved before the send as target-mismatch', async () => {
    const { producer, host, finishCalls } = harness({ reader: movedBeforeSendReader() })
    await expect(
      producer({ ...PRODUCE_REQUEST, paths: ['src/feature.ts'] }, new AbortController().signal)
    ).resolves.toEqual({ kind: 'failed', reason: 'target-mismatch' })
    expect(host.sends).toHaveLength(0)
    expect(finishCalls[0]?.outcome).toEqual({ kind: 'failed', reason: 'target-mismatch' })
  })

  it('settles a reader that cannot be opened as a producer failure before any send', async () => {
    const { producer, host, calls, finishCalls } = harness({ reader: null })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'failed',
      reason: 'producer-failed'
    })
    expect(calls.openReader).toBe(1)
    expect(host.sends).toHaveLength(0)
    expect(finishCalls[0]?.outcome).toEqual({ kind: 'failed', reason: 'producer-failed' })
  })

  it('refuses when the record disappears while the host was installed', async () => {
    const { producer, host, finishCalls } = harness({ records: [record(), null] })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'refused',
      reason: 'session-missing'
    })
    expect(host.sends).toHaveLength(0)
    expect(finishCalls[0]?.outcome).toEqual({
      kind: 'failed',
      reason: 'session-binding-lost'
    })
  })

  it('refuses when the record loses its binding while the host was installed', async () => {
    const { producer, host, finishCalls } = harness({
      records: [record(), { ...record(), protectedAnalysis: { ...SUBJECT, itemId: '8' } }]
    })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'refused',
      reason: 'session-not-protected'
    })
    expect(host.sends).toHaveLength(0)
    expect(finishCalls[0]?.outcome).toEqual({
      kind: 'failed',
      reason: 'session-binding-lost'
    })
  })

  it('reports a refused settlement instead of the produce refusal', async () => {
    const { producer, finishCalls } = harness({
      records: [{ ...record(), protectedClaudeLaunch: undefined }],
      ledger: { finish: () => ({ kind: 'refused', reason: 'request-digest-mismatch' }) }
    })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'refused',
      reason: 'finish-refused'
    })
    expect(finishCalls).toHaveLength(1)
  })

  it('reports a refused settlement after the protected turn instead of a proposal', async () => {
    const { producer, finishCalls } = harness({
      ledger: { finish: () => ({ kind: 'refused', reason: 'request-digest-mismatch' }) }
    })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'refused',
      reason: 'finish-refused'
    })
    expect(finishCalls[0]?.outcome).toMatchObject({ kind: 'success' })
  })

  it('adopts a terminal answer the ledger settled before this attempt', async () => {
    const { producer } = harness({
      reader: null,
      ledger: {
        finish: (_input, current) => ({
          kind: 'completed',
          request: {
            ...current,
            state: 'succeeded',
            proposalId: PROPOSAL_ID,
            reasonCode: null
          },
          proposal: {
            id: PROPOSAL_ID,
            runId: current.runId,
            itemId: current.itemId,
            revision: current.revision,
            policyGeneration: current.policyGeneration,
            status: 'pending',
            body: {},
            createdAt: 2,
            resolvedAt: null
          }
        })
      }
    })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'proposal',
      proposalId: PROPOSAL_ID,
      requestId: REQUEST_ID
    })
  })

  it('rejects when the ledger cannot record the attempt it just made', async () => {
    const { producer, host } = harness({ ledger: { finishThrows: true } })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).rejects.toThrow(
      'finish failed'
    )
    expect(host.sends).toHaveLength(1)
  })

  it('refuses a record without the protected launch marker before any send', async () => {
    const { producer, host, calls, finishCalls } = harness({
      records: [{ ...record(), protectedClaudeLaunch: undefined }]
    })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'refused',
      reason: 'session-not-protected'
    })
    expect(calls.ensureHost).toBe(0)
    expect(calls.openReader).toBe(0)
    expect(host.sends).toHaveLength(0)
    expect(finishCalls).toHaveLength(1)
    expect(finishCalls[0]?.outcome).toEqual({
      kind: 'failed',
      reason: 'session-binding-lost'
    })
  })

  it('refuses when the record fence moved while the host was installed', async () => {
    const { producer, host, finishCalls } = harness({ records: [record(7), record(8)] })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'refused',
      reason: 'send-refused'
    })
    expect(host.sends).toHaveLength(0)
    expect(finishCalls).toHaveLength(1)
    expect(finishCalls[0]?.outcome).toEqual({
      kind: 'failed',
      reason: 'session-binding-lost'
    })
  })

  it('settles a moved request fence before opening a reader', async () => {
    const { producer, host, calls, finishCalls } = harness({
      ledger: { fences: () => ({ ok: false, reason: 'revision-stale' }) }
    })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'failed',
      reason: 'revision-stale'
    })
    expect(calls.openReader).toBe(0)
    expect(host.sends).toHaveLength(0)
    expect(finishCalls[0]?.outcome).toEqual({ kind: 'failed', reason: 'revision-stale' })
  })

  it('settles a fork target before any send', async () => {
    const { producer, host, finishCalls } = harness({
      reader: reader({
        getMergeRequest: async () => ({
          ok: true,
          data: mergeRequest({ source_project_id: 43 }),
          complete: true
        })
      })
    })
    await expect(
      producer({ ...PRODUCE_REQUEST, paths: ['src/feature.ts'] }, new AbortController().signal)
    ).resolves.toEqual({ kind: 'failed', reason: 'target-mismatch' })
    expect(host.sends).toHaveLength(0)
    expect(finishCalls[0]?.outcome).toEqual({ kind: 'failed', reason: 'target-mismatch' })
  })

  it('settles more than 32 derived paths as a producer failure before any send', async () => {
    const { producer, host, finishCalls } = harness({
      reader: reader({
        getMergeRequestDiffs: async () => ({
          ok: true,
          data: Array.from({ length: 33 }, (_, index) =>
            diff({ old_path: `src/file-${index}.ts`, new_path: `src/file-${index}.ts` })
          ),
          complete: true
        })
      })
    })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'failed',
      reason: 'producer-failed'
    })
    expect(host.sends).toHaveLength(0)
    expect(finishCalls[0]?.outcome).toEqual({ kind: 'failed', reason: 'producer-failed' })
  })

  it('reads a repeated explicit path once instead of failing the whole request', async () => {
    const { producer, host, claimCalls, finishCalls } = harness()
    await expect(
      producer(
        { ...PRODUCE_REQUEST, paths: ['src/feature.ts', 'src/feature.ts'] },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ kind: 'proposal' })
    expect(claimCalls[0]?.intent.paths).toEqual(['src/feature.ts'])
    expect(host.sends).toHaveLength(1)
    expect(finishCalls[0]?.outcome).toMatchObject({ kind: 'success' })
  })

  it('settles a signal aborted before the send as a producer failure', async () => {
    const { producer, host, finishCalls } = harness()
    const controller = new AbortController()
    controller.abort()
    await expect(producer(PRODUCE_REQUEST, controller.signal)).resolves.toEqual({
      kind: 'failed',
      reason: 'producer-failed'
    })
    expect(host.sends).toHaveLength(0)
    expect(finishCalls).toHaveLength(1)
    expect(finishCalls[0]?.outcome).toEqual({ kind: 'failed', reason: 'producer-failed' })
  })

  it.each(['readRecord', 'openReader', 'ensureHost'] as const)(
    'settles a thrown %s as a producer failure exactly once',
    async (throwing) => {
      const { producer, host, finishCalls } = harness({ throwing })
      await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
        kind: 'failed',
        reason: 'producer-failed'
      })
      expect(host.sends).toHaveLength(0)
      expect(finishCalls).toHaveLength(1)
      expect(finishCalls[0]?.outcome).toEqual({ kind: 'failed', reason: 'producer-failed' })
    }
  )

  it('settles a thrown host send as unverifiable exactly once', async () => {
    const { producer, host, finishCalls } = harness({ throwing: 'send' })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'unverifiable',
      reason: 'unknown-outcome'
    })
    expect(host.sends).toHaveLength(1)
    expect(finishCalls).toHaveLength(1)
    expect(finishCalls[0]?.outcome).toEqual({ kind: 'unverifiable', reason: 'unknown-outcome' })
  })

  it('settles a throw after the successful send as unverifiable exactly once', async () => {
    const { producer, host, finishCalls } = harness({ reader: throwingThirdVerifyReader() })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'unverifiable',
      reason: 'unknown-outcome'
    })
    expect(host.sends).toHaveLength(1)
    expect(finishCalls).toHaveLength(1)
    expect(finishCalls[0]?.outcome).toEqual({ kind: 'unverifiable', reason: 'unknown-outcome' })
  })

  it('replays a failed session-binding-lost request', async () => {
    const { producer, host, calls, finishCalls } = harness({
      ledger: {
        claim: {
          kind: 'terminal',
          request: request({ state: 'failed', reasonCode: 'session-binding-lost' })
        }
      }
    })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'failed',
      reason: 'session-binding-lost'
    })
    expect(calls).toEqual({ openReader: 0, ensureHost: 0, readRecord: 0 })
    expect(host.sends).toHaveLength(0)
    expect(finishCalls).toHaveLength(0)
  })

  it.each([
    ['interrupted', 'interrupted'],
    ['unknown-outcome', 'unknown-outcome'],
    [null, 'unknown-outcome']
  ] as const)('replays an unverifiable request coded %j as %j', async (reasonCode, expected) => {
    const { producer, host, finishCalls } = harness({
      ledger: {
        claim: {
          kind: 'unverifiable',
          request: request({ state: 'unverifiable', reasonCode })
        }
      }
    })
    await expect(producer(PRODUCE_REQUEST, new AbortController().signal)).resolves.toEqual({
      kind: 'unverifiable',
      reason: expected
    })
    expect(host.sends).toHaveLength(0)
    expect(finishCalls).toHaveLength(0)
  })
})

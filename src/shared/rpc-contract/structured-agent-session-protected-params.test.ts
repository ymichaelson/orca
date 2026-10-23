import { describe, expect, it } from 'vitest'
import { CreateIntentParams, SendParams } from './structured-agent-session-params'

const ENVELOPE = {
  sessionId: 'agent-session-0123456789abcdef0123456789abcdef',
  clientOperationId: 'op-1',
  expectedRuntimeFence: null,
  payloadFingerprint: 'a'.repeat(64)
}
const BODY = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }
const MARKER = {
  ownerId: '0b8f2c1e-5a3d-4f6b-9c7e-1d2a3b4c5d6e',
  instanceId: 'instance-1',
  itemId: '101',
  analysisKind: 'merge_request'
}

describe('the structured chat wire cannot carry a protected analysis marker', () => {
  it('refuses a create that names one', () => {
    const create = { envelope: ENVELOPE, worktree: 'wt', agent: 'codex' }
    expect(CreateIntentParams.safeParse(create).success).toBe(true)
    expect(CreateIntentParams.safeParse({ ...create, protectedAnalysis: MARKER }).success).toBe(
      false
    )
  })

  it('refuses a send that names one', () => {
    const send = { envelope: ENVELOPE, body: BODY }
    expect(SendParams.safeParse(send).success).toBe(true)
    expect(SendParams.safeParse({ ...send, protectedAnalysis: MARKER }).success).toBe(false)
  })
})

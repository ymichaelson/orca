import type { McpServerStatus, SDKControlInitializeResponse } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { claudeUserMessageWasProvablyUnwritten } from './claude-agent-sdk-user-message-queue'
import { createProtectedClaudeTransportGate } from './claude-protected-transport-gate'

function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

const MESSAGE = { type: 'user', message: { role: 'user', content: 'private MR canary' } }

function timingOut() {
  return new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100))
}

describe('protected Claude transport gate cancellation', () => {
  it('settles a proof cancelled before admission, so a held send rejects as unwritten', async () => {
    const fault = vi.fn()
    const gate = createProtectedClaudeTransportGate({
      session: {
        initializationResult: () => never<SDKControlInitializeResponse>(),
        mcpServerStatus: () => never<McpServerStatus[]>()
      },
      pinnedModel: undefined,
      fault
    })
    const hold = gate.dispatch(MESSAGE).beforeDispatch()
    const settled = hold.then(
      () => 'resolved' as const,
      (error: unknown) => error
    )
    gate.cancel()
    const outcome = await Promise.race([settled, timingOut()])
    expect(outcome).not.toBe('pending')
    expect(claudeUserMessageWasProvablyUnwritten(outcome)).toBe(true)
    await expect(gate.proof).rejects.toThrow()
    expect(fault).not.toHaveBeenCalled()
  })

  it('cancels after an admitted proof without disturbing a settled send', async () => {
    const fault = vi.fn()
    const gate = createProtectedClaudeTransportGate({
      session: {
        initializationResult: () =>
          Promise.resolve({
            commands: [],
            agents: [],
            output_style: 'default',
            available_output_styles: [],
            models: [],
            account: {},
            hooks_applied: false,
            plugins_applied: false
          }),
        mcpServerStatus: () => Promise.resolve([])
      },
      pinnedModel: undefined,
      fault
    })
    await gate.dispatch(MESSAGE).beforeDispatch()
    gate.cancel()
    await expect(gate.proof).resolves.toBeUndefined()
    expect(fault).not.toHaveBeenCalled()
  })
})

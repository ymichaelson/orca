import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'
import { forgeRunActivitySteps } from './forge-inbox-run-activity-steps'

function item(itemId: string, body: AgentJournalItemBody, sequence = 1): AgentJournalRenderItem {
  return { itemId, revision: 1, sequence, observedAt: sequence * 10, body }
}

describe('forgeRunActivitySteps', () => {
  it('shows newest first, naming the tool and what it acts on', () => {
    const items = [
      item(
        '1',
        { kind: 'tool-call', name: 'Read', input: { file_path: 'src/a.ts' }, state: 'completed' },
        1
      ),
      item(
        '2',
        { kind: 'tool-call', name: 'Bash', input: { command: 'pnpm test' }, state: 'running' },
        2
      )
    ]

    expect(forgeRunActivitySteps(items, 6)).toEqual([
      { id: '2', kind: 'tool', label: 'Bash', detail: 'pnpm test', state: 'running', at: 20 },
      { id: '1', kind: 'tool', label: 'Read', detail: 'src/a.ts', state: 'completed', at: 10 }
    ])
  })

  it('keeps only the newest steps the card has room for', () => {
    const items = [1, 2, 3, 4].map((sequence) =>
      item(
        `${sequence}`,
        {
          kind: 'tool-call',
          name: 'Read',
          input: { file_path: `src/${sequence}.ts` },
          state: 'completed'
        },
        sequence
      )
    )

    expect(forgeRunActivitySteps(items, 2).map((step) => step.detail)).toEqual([
      'src/4.ts',
      'src/3.ts'
    ])
  })

  it('shows the agent turning a file, and its own words, but not the prompts it was given', () => {
    const items = [
      item(
        '1',
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Review this MR.' }] },
        1
      ),
      item(
        '2',
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'I read\nthe diff.' }],
          state: 'completed'
        },
        2
      ),
      item(
        '3',
        {
          kind: 'diff',
          path: 'src/a.ts',
          patch: { head: '', byteLength: 0, digest: 'd', truncated: false }
        },
        3
      ),
      item('4', { kind: 'turn', turnId: 't1', state: 'running' }, 4)
    ]

    expect(forgeRunActivitySteps(items, 6)).toEqual([
      { id: '3', kind: 'edit', label: 'Edit', detail: 'src/a.ts', state: 'completed', at: 30 },
      {
        id: '2',
        kind: 'message',
        label: 'Agent',
        detail: 'I read the diff.',
        state: 'completed',
        at: 20
      }
    ])
  })
})

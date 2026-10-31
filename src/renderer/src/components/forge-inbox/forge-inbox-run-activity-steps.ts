import { translate } from '@/i18n/i18n'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { isTextBlock, type NativeChatBlock } from '../../../../shared/native-chat-types'
import { describeToolInput } from '../../../../shared/native-chat-tool-summary'

export type ForgeRunActivityStepKind = 'tool' | 'message' | 'edit'
export type ForgeRunActivityStepState = 'running' | 'completed' | 'failed'

/** One thing the dispatched agent did, as the run card shows it without opening the session. */
export type ForgeRunActivityStep = {
  id: string
  kind: ForgeRunActivityStepKind
  /** What ran: a tool name, the agent's own turn, or the file it rewrote. */
  label: string
  detail: string
  state: ForgeRunActivityStepState
  at: number
}

const MESSAGE_PREVIEW_LIMIT = 160

function collapse(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MESSAGE_PREVIEW_LIMIT ? `${flat.slice(0, MESSAGE_PREVIEW_LIMIT - 1)}…` : flat
}

function assistantText(blocks: readonly NativeChatBlock[]): string {
  return collapse(
    blocks
      .filter(isTextBlock)
      .map((block) => block.text)
      .join(' ')
  )
}

function stepOf(item: AgentJournalRenderItem): ForgeRunActivityStep | null {
  const { body } = item
  switch (body.kind) {
    case 'tool-call':
      return {
        id: item.itemId,
        kind: 'tool',
        label: body.name,
        detail: describeToolInput(body.input),
        state: body.state,
        at: item.observedAt
      }
    case 'diff':
      return {
        id: item.itemId,
        kind: 'edit',
        label: translate('auto.components.forge-inbox.ForgeInboxRunActivity.editLabel', 'Edit'),
        detail: body.path,
        state: 'completed',
        at: item.observedAt
      }
    case 'message': {
      if (body.role !== 'assistant') {
        return null
      }
      const detail = assistantText(body.blocks)
      return detail.length === 0
        ? null
        : {
            id: item.itemId,
            kind: 'message',
            label: translate(
              'auto.components.forge-inbox.ForgeInboxRunActivity.agentLabel',
              'Agent'
            ),
            detail,
            state: body.state === 'running' ? 'running' : 'completed',
            at: item.observedAt
          }
    }
    // Prompts, turn boundaries and host frames are not steps the agent took.
    case 'approval':
    case 'question':
    case 'status':
    case 'turn':
      return null
  }
}

/** Newest first, like the item timeline: what the run is doing now, then what it just did. */
export function forgeRunActivitySteps(
  items: readonly AgentJournalRenderItem[],
  limit: number
): ForgeRunActivityStep[] {
  const steps: ForgeRunActivityStep[] = []
  for (let index = items.length - 1; index >= 0 && steps.length < limit; index--) {
    const item = items[index]
    if (item === undefined) {
      continue
    }
    const step = stepOf(item)
    if (step !== null) {
      steps.push(step)
    }
  }
  return steps
}

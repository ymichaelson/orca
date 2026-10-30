// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectEventQuestionView } from '../../../../shared/forge-inbox-project-event-question'
import { FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES } from '../../../../shared/forge-inbox-project-event-question'

const mocks = vi.hoisted(() => ({ answer: vi.fn() }))

vi.mock('@/runtime/project-event-client', () => ({
  answerProjectEventQuestion: mocks.answer
}))

import { ForgeInboxQuestionPanel } from './ForgeInboxQuestionPanel'

function question(overrides: Partial<ProjectEventQuestionView> = {}): ProjectEventQuestionView {
  return {
    id: 11,
    itemId: 3,
    question: '需要你确认：merge_request !7 中的变更是否要继续处理？',
    subject: { kind: 'merge_request', iid: 7, title: 'Add thing' },
    source: 'exhausted',
    status: 'open',
    askedAt: 1_700_000_000_000,
    answeredAt: null,
    ...overrides
  }
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(label)
  )
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`no button matching ${label}`)
  }
  return found
}

function setAnswer(container: HTMLElement, value: string): void {
  const textarea = container.querySelector('textarea')
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error('no answer textarea')
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ForgeInboxQuestionPanel', () => {
  let container: HTMLDivElement
  let root: Root
  const onAnswered = vi.fn()

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    onAnswered.mockReset()
    mocks.answer.mockReset()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function render(
    questions: ProjectEventQuestionView[],
    ownerHostId = 'host-1'
  ): Promise<void> {
    await act(async () => {
      root.render(
        <ForgeInboxQuestionPanel
          ownerHostId={ownerHostId}
          ownerTarget={{ kind: 'local' }}
          questions={questions}
          onAnswered={onAnswered}
        />
      )
    })
  }

  it('shows the question a task asked, not the generic sentence it replaced', async () => {
    await render([
      question({ source: 'answer', question: 'Merge before the release, or wait for the tests?' })
    ])

    expect(container.textContent).toContain('Merge before the release, or wait for the tests?')
    expect(container.textContent).not.toContain('Merge request !7')
  })

  it('renders the fixed facts in the reader’s language and sends the trimmed answer', async () => {
    mocks.answer.mockResolvedValue({
      ownerHostId: 'host-1',
      ok: true,
      question: question({ status: 'answered', answeredAt: 1 })
    })
    await render([question()])

    expect(container.textContent).toContain('Merge request !7')
    expect(container.textContent).toContain('Add thing')
    expect(container.textContent).not.toContain('需要你确认')
    setAnswer(container, '  continue after tests  ')
    await act(async () => button(container, 'Send answer').click())

    expect(mocks.answer).toHaveBeenCalledWith('host-1', 11, 'continue after tests', {
      kind: 'local'
    })
    expect(onAnswered).toHaveBeenCalled()
  })

  it.each([
    ['pipeline', 'Pipeline #1001'],
    ['issue', 'Issue #11']
  ])('writes a %s the way GitLab references it', async (kind, reference) => {
    await render([question({ subject: { kind, iid: kind === 'issue' ? 11 : 1001, title: '' } })])

    expect(container.textContent).toContain(reference)
    expect(container.textContent).not.toMatch(/!1001|!11/)
  })

  it('asks about the latest event of a project, which has no number', async () => {
    await render([question({ subject: { kind: 'project', iid: 0, title: '' } })])

    expect(container.textContent).toContain('latest event in this project')
    expect(container.textContent).not.toMatch(/[!#]0/)
  })

  it('falls back to the stored sentence when the host wrote no facts', async () => {
    await render([question({ subject: null })])

    expect(container.textContent).toContain('需要你确认：merge_request !7')
  })

  it('refuses an empty or over-long answer without calling the host', async () => {
    await render([question()])

    expect(button(container, 'Send answer').disabled).toBe(true)
    setAnswer(container, '   ')
    expect(button(container, 'Send answer').disabled).toBe(true)

    setAnswer(container, 'x'.repeat(FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES + 1))
    expect(button(container, 'Send answer').disabled).toBe(true)
    expect(container.textContent).toContain('The answer is too long.')
    expect(mocks.answer).not.toHaveBeenCalled()
  })

  it('keeps the answer visible when the host refuses it', async () => {
    mocks.answer.mockResolvedValue({ ownerHostId: 'host-1', ok: false, reason: 'not-found' })
    await render([question()])

    setAnswer(container, 'retry me')
    await act(async () => button(container, 'Send answer').click())

    expect(container.textContent).toContain('Could not send the answer')
    expect(container.querySelector('textarea')?.value).toBe('retry me')
    expect(onAnswered).not.toHaveBeenCalled()
  })

  it('renders nothing when the item has no open question', async () => {
    await render([])

    expect(container.textContent).toBe('')
  })
})

import { describe, expect, it } from 'vitest'
import { forgeQuestionCopy } from './forge-inbox-question-copy'

const SUBJECT = { kind: 'merge_request', iid: 7, title: 'Add thing' }
const ASKED = 'Merge before the release?'

describe('forge question copy', () => {
  it('shows the question a task asked instead of replacing it with the generic sentence', () => {
    expect(forgeQuestionCopy({ question: ASKED, subject: SUBJECT, source: 'answer' })).toBe(ASKED)
  })

  it('words the host fallback from the subject facts in the reader’s language', () => {
    const copy = forgeQuestionCopy({ question: 'host copy', subject: SUBJECT, source: 'exhausted' })
    expect(copy).toContain('!7')
    expect(copy).toContain('Add thing')
    expect(copy).not.toBe('host copy')
  })

  it('keeps the stored sentence when nothing about the item is known', () => {
    expect(forgeQuestionCopy({ question: ASKED, subject: null, source: 'exhausted' })).toBe(ASKED)
    expect(forgeQuestionCopy({ question: ASKED, subject: null })).toBe(ASKED)
  })
})

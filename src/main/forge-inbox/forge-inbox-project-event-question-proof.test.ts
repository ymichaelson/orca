import { describe, expect, it } from 'vitest'
import { parseQuestionProof } from './forge-inbox-project-event-question-proof'

function fenced(value: unknown): string {
  return `\`\`\`orca-question\n${JSON.stringify(value)}\n\`\`\``
}

describe('project event question proof', () => {
  it('reads one minimal question and one bare decline, and nothing else', () => {
    expect(parseQuestionProof(fenced({ v: 1, kind: 'question', question: 'Merge now?' }))).toEqual({
      kind: 'question',
      question: 'Merge now?'
    })
    expect(parseQuestionProof('```orca-question\n{"v":1,"kind":"cannot_prepare"}\n```')).toEqual({
      kind: 'declined'
    })
    expect(
      parseQuestionProof(
        'I cannot prepare this.\n```orca-question\n{"v":1,"kind":"cannot_prepare"}\n```'
      )
    ).toBeNull()
    expect(parseQuestionProof(fenced({ v: 1, kind: 'question', question: '   ' }))).toBeNull()
    expect(
      parseQuestionProof(fenced({ v: 1, kind: 'question', question: 'A?', extra: 1 }))
    ).toBeNull()
    expect(parseQuestionProof(null)).toBeNull()
  })
})

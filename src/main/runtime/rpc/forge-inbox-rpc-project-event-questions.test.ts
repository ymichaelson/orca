import { describe, expect, it } from 'vitest'
import {
  ForgeInboxAnswerProjectEventQuestionParams,
  ForgeInboxListProjectEventQuestionsParams
} from '../../../shared/rpc-contract/forge-inbox-params'
import { FORGE_INBOX_METHODS } from './methods/forge-inbox'

const LIST_QUESTION = 'forgeInbox.listProjectEventQuestions'
const ANSWER_QUESTION = 'forgeInbox.answerProjectEventQuestion'

function isQuestionMethod(name: string): boolean {
  return name === LIST_QUESTION || name === ANSWER_QUESTION
}

function questionMethods() {
  return FORGE_INBOX_METHODS.filter((method) => isQuestionMethod(method.name))
}

describe('forge inbox project event question rpc', () => {
  it('registers both question methods for the workspace permission', () => {
    expect(questionMethods().map((method) => method.name)).toEqual([LIST_QUESTION, ANSWER_QUESTION])
    for (const method of questionMethods()) {
      expect(method.permission).toBe('workspace')
    }
  })

  it('accepts a list request with an optional status filter', () => {
    expect(
      ForgeInboxListProjectEventQuestionsParams.safeParse({ ownerHostId: 'host-a' }).success
    ).toBe(true)
    expect(
      ForgeInboxListProjectEventQuestionsParams.safeParse({
        ownerHostId: 'host-a',
        status: 'open'
      }).success
    ).toBe(true)
    expect(
      ForgeInboxListProjectEventQuestionsParams.safeParse({
        ownerHostId: 'host-a',
        status: 'pending'
      }).success
    ).toBe(false)
    expect(ForgeInboxListProjectEventQuestionsParams.safeParse({}).success).toBe(false)
  })

  it('bounds the answer by UTF-8 bytes and forbids NUL', () => {
    const parse = (answer: unknown) =>
      ForgeInboxAnswerProjectEventQuestionParams.safeParse({
        ownerHostId: 'host-a',
        questionId: 1,
        answer
      }).success

    expect(parse('yes')).toBe(true)
    expect(parse('汉'.repeat(666))).toBe(true)
    expect(parse('汉'.repeat(667))).toBe(false)
    expect(parse('')).toBe(false)
    expect(parse('yes\u0000')).toBe(false)
    expect(parse('x'.repeat(2001))).toBe(false)
  })

  it('requires a positive question id and rejects unknown fields', () => {
    const base = { ownerHostId: 'host-a', answer: 'yes' }
    expect(
      ForgeInboxAnswerProjectEventQuestionParams.safeParse({ ...base, questionId: 1 }).success
    ).toBe(true)
    for (const questionId of [0, -1, 1.5, '1', null]) {
      expect(
        ForgeInboxAnswerProjectEventQuestionParams.safeParse({ ...base, questionId }).success
      ).toBe(false)
    }
    expect(
      ForgeInboxAnswerProjectEventQuestionParams.safeParse({
        ...base,
        questionId: 1,
        injected: true
      }).success
    ).toBe(false)
  })
})

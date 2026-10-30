import {
  ForgeInboxAnswerProjectEventQuestionParams,
  ForgeInboxListProjectEventQuestionsParams
} from '../../../../shared/rpc-contract/forge-inbox-params'
import { FORGE_INBOX_RPC_ERROR_CODES } from '../../../../shared/forge-inbox-rpc-errors'
import { defineMethod } from '../core'
import { forgeOwnerFor, guardForgeInbox } from '../forge-inbox-owner-gate'

// Why 'workspace': the paired caller that reads the inbox is the one that answers its questions.
export const FORGE_INBOX_PROJECT_EVENT_QUESTION_METHODS = [
  defineMethod({
    name: 'forgeInbox.listProjectEventQuestions',
    permission: 'workspace',
    params: ForgeInboxListProjectEventQuestionsParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(FORGE_INBOX_RPC_ERROR_CODES.unavailable, () => ({
        ownerHostId: params.ownerHostId,
        questions: service.listProjectEventQuestions(params.status, params.ownerHostId)
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.answerProjectEventQuestion',
    permission: 'workspace',
    params: ForgeInboxAnswerProjectEventQuestionParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(FORGE_INBOX_RPC_ERROR_CODES.unavailable, async () => ({
        ownerHostId: params.ownerHostId,
        ...(await service.answerProjectEventQuestion(
          params.questionId,
          params.answer,
          params.ownerHostId
        ))
      }))
    }
  })
]

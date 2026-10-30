const QUESTION_MAX_BYTES = 4000
const OUTPUT_MAX_BYTES = 8192
const DECLINED_PROOF = '```orca-question\n{"v":1,"kind":"cannot_prepare"}\n```'

// eslint-disable-next-line no-control-regex -- stored questions must reject control characters
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u

function questionFromProof(text: string | null): string | null {
  if (text === null || Buffer.byteLength(text, 'utf8') > OUTPUT_MAX_BYTES) {
    return null
  }
  const match = /^```orca-question\s*\n([^\n]*)\n```\s*$/.exec(text.trim())
  if (!match) {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(match[1])
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  if (!('v' in value) || value.v !== 1 || !('kind' in value) || value.kind !== 'question') {
    return null
  }
  if (!('question' in value) || typeof value.question !== 'string') {
    return null
  }
  const question = value.question
  const invalid =
    !question.trim() ||
    !question.isWellFormed() ||
    Buffer.byteLength(question, 'utf8') > QUESTION_MAX_BYTES ||
    CONTROL_CHARACTERS.test(question) ||
    Object.keys(value).some((key) => !['v', 'kind', 'question'].includes(key))
  return invalid ? null : question
}

export type QuestionProof = { kind: 'question'; question: string } | { kind: 'declined' } | null

/**
 * Only an exact turn proves a question or a decline. Anything else, including a decline wrapped in
 * extra text, is no proof at all.
 */
export function parseQuestionProof(text: string | null): QuestionProof {
  const question = questionFromProof(text)
  if (question !== null) {
    return { kind: 'question', question }
  }
  return text?.trim() === DECLINED_PROOF ? { kind: 'declined' } : null
}

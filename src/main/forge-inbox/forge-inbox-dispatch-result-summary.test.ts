import { describe, expect, it } from 'vitest'
import { getUtf8ByteLength } from '../../shared/utf8-byte-limits'
import {
  DISPATCH_RESULT_SUMMARY_MAX_BYTES,
  dispatchResultFromTurnText
} from './forge-inbox-dispatch-result-summary'

const MARKER = '<!-- orca-run:12:0123456789abcdef0123456789abcdef -->'
const FENCE = '```orca-effect-report\n{"v":1,"mode":"read-only","claims":[]}\n```'

describe('dispatch result summary', () => {
  it('keeps the human text and drops the effect report fence and the host marker', () => {
    const result = dispatchResultFromTurnText(`Reviewed the change.\n${MARKER}\n\n${FENCE}\n`)

    expect(result).toEqual({ summary: 'Reviewed the change.', concerns: [] })
  })

  it('drops an unterminated report fence rather than showing its JSON', () => {
    const result = dispatchResultFromTurnText('Done.\n```orca-effect-report\n{"v":1,')

    expect(result?.summary).toBe('Done.')
  })

  it('is unavailable when the turn had no text or only the report', () => {
    expect(dispatchResultFromTurnText(null)).toBeNull()
    expect(dispatchResultFromTurnText('   \n')).toBeNull()
    expect(dispatchResultFromTurnText(`${FENCE}\n`)).toBeNull()
  })

  it('bounds the summary by UTF-8 bytes without splitting a character', () => {
    const result = dispatchResultFromTurnText('é'.repeat(DISPATCH_RESULT_SUMMARY_MAX_BYTES))

    expect(getUtf8ByteLength(result?.summary ?? '')).toBeLessThanOrEqual(
      DISPATCH_RESULT_SUMMARY_MAX_BYTES
    )
    expect(result?.summary).toMatch(/^é+$/)
  })
})

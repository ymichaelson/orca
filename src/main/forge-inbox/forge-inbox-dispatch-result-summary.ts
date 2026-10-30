import type { ForgeAnalysisResult } from '../../shared/forge-inbox-types'
import { clampUtf8TextPrefix } from '../../shared/utf8-byte-limits'
import { DISPATCH_REPORT_FENCE_TAG } from './forge-inbox-dispatch-report'

export const DISPATCH_RESULT_SUMMARY_MAX_BYTES = 8 * 1024

const REPORT_OPENER = `\`\`\`${DISPATCH_REPORT_FENCE_TAG}`
const RUN_MARKER_LINE = /^\s*<!-- orca-run:\d+:[0-9a-f]+ -->\s*$/

function withoutReportFences(lines: string[]): string[] {
  const kept: string[] = []
  let inReport = false
  for (const line of lines) {
    if (inReport) {
      inReport = line.trimEnd() !== '```'
    } else if (line.trim().startsWith(REPORT_OPENER)) {
      inReport = true
    } else {
      kept.push(line)
    }
  }
  return kept
}

/** The turn's final text as an untrusted summary; nothing readable means unavailable, never invented. */
export function dispatchResultFromTurnText(text: string | null): ForgeAnalysisResult | null {
  if (text === null) {
    return null
  }
  const human = withoutReportFences(text.split(/\r?\n/))
    .filter((line) => !RUN_MARKER_LINE.test(line))
    .join('\n')
    .trim()
  if (human === '') {
    return null
  }
  return { summary: clampUtf8TextPrefix(human, DISPATCH_RESULT_SUMMARY_MAX_BYTES), concerns: [] }
}

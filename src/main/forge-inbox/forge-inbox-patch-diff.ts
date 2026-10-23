import { createTwoFilesPatch } from 'diff'
import { sha256OfContent, type ForgePatchDraft } from './forge-inbox-patch-draft'

/** A display the owner cannot finish reading is refused rather than truncated. */
export const FORGE_PATCH_DIFF_MAX_BYTES = 512 * 1024

export type ForgePatchDiffResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'base-missing' | 'base-unexpected' | 'base-mismatch' | 'diff-too-large' }

/**
 * The exact diff the owner approves: built by the host from the immutable manifest and the base
 * contents it read at the reviewed commit, never from agent-rendered text.
 */
export function renderForgePatchDiff(
  draft: ForgePatchDraft,
  readBase: (path: string) => string | null
): ForgePatchDiffResult {
  const parts: string[] = []
  let bytes = 0
  for (const operation of draft.operations) {
    const base = readBase(operation.path)
    let text: string
    if (operation.op === 'create') {
      if (base !== null) {
        return { ok: false, reason: 'base-unexpected' }
      }
      text = createTwoFilesPatch('/dev/null', `b/${operation.path}`, '', operation.content)
    } else {
      if (base === null) {
        return { ok: false, reason: 'base-missing' }
      }
      if (sha256OfContent(base) !== operation.baseSha256) {
        return { ok: false, reason: 'base-mismatch' }
      }
      text =
        operation.op === 'update'
          ? createTwoFilesPatch(
              `a/${operation.path}`,
              `b/${operation.path}`,
              base,
              operation.content
            )
          : createTwoFilesPatch(`a/${operation.path}`, '/dev/null', base, '')
    }
    bytes += Buffer.byteLength(text, 'utf8')
    if (bytes > FORGE_PATCH_DIFF_MAX_BYTES) {
      return { ok: false, reason: 'diff-too-large' }
    }
    parts.push(text)
  }
  return { ok: true, text: parts.join('') }
}

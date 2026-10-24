import type { ForgePatchDiffFailure } from '../../shared/forge-inbox-rpc-types'
import type { ForgePatchDraft } from './forge-inbox-patch-draft'
import { renderForgePatchDiff } from './forge-inbox-patch-diff'
import type { ForgePatchSource } from './forge-inbox-patch-tree'

export type ForgePatchPreviewDiffResult =
  | { ok: true; text: string }
  | { ok: false; reason: ForgePatchDiffFailure }

/**
 * Reads every path the manifest names and then renders the same exact diff approval applies.
 * A base that cannot be read is refused, never approximated from the manifest alone.
 */
export async function readForgePatchPreviewDiff(
  draft: ForgePatchDraft,
  source: ForgePatchSource
): Promise<ForgePatchPreviewDiffResult> {
  const contents = new Map<string, string | null>()
  for (const operation of draft.operations) {
    if (contents.has(operation.path)) {
      continue
    }
    const read = await source.readPath(operation.path)
    if (read.kind === 'unavailable') {
      return { ok: false, reason: 'base-unavailable' }
    }
    if (read.kind === 'unsupported') {
      return { ok: false, reason: 'base-unsupported' }
    }
    contents.set(operation.path, read.kind === 'file' ? read.content : null)
  }
  return renderForgePatchDiff(draft, (path) => contents.get(path) ?? null)
}

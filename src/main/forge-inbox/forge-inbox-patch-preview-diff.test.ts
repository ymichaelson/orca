import { describe, expect, it } from 'vitest'
import {
  buildForgePatchDraft,
  sha256OfContent,
  type ForgePatchDraft,
  type ForgePatchOperation
} from './forge-inbox-patch-draft'
import { readForgePatchPreviewDiff } from './forge-inbox-patch-preview-diff'
import type { ForgePatchPathContent, ForgePatchSource } from './forge-inbox-patch-tree'

const BASE = 'a'.repeat(40)
const TARGET = { instanceId: 'gitlab-main', projectId: '42' }

function draftOf(operations: ForgePatchOperation[]): ForgePatchDraft {
  const built = buildForgePatchDraft({ target: TARGET, baseSha: BASE, branch: 'main', operations })
  if (!built.ok) {
    throw new Error(`draft rejected: ${built.reason}`)
  }
  return built.draft
}

function sourceOf(paths: Record<string, string | ForgePatchPathContent>): ForgePatchSource {
  return {
    readPath: (path) => {
      const entry = paths[path]
      if (entry === undefined) {
        return Promise.resolve({ kind: 'missing' })
      }
      return Promise.resolve(typeof entry === 'string' ? { kind: 'file', content: entry } : entry)
    }
  }
}

const CREATED = 'export const a = 1\n'

function updateOp(): ForgePatchOperation {
  return {
    op: 'update',
    path: 'src/a.ts',
    baseSha256: sha256OfContent('old\n'),
    content: 'new\n',
    resultSha256: sha256OfContent('new\n')
  }
}

describe('forge patch preview diff', () => {
  it('renders the exact diff from the files the base actually holds', async () => {
    const draft = draftOf([
      updateOp(),
      { op: 'create', path: 'src/b.ts', content: CREATED, resultSha256: sha256OfContent(CREATED) }
    ])

    const diff = await readForgePatchPreviewDiff(
      draft,
      sourceOf({ 'src/a.ts': 'old\n', 'src/b.ts': { kind: 'missing' } })
    )

    expect(diff.ok).toBe(true)
    if (!diff.ok) {
      return
    }
    expect(diff.text).toContain('-old')
    expect(diff.text).toContain('+new')
    expect(diff.text).toContain('--- /dev/null')
    expect(diff.text).toContain('+export const a = 1')
  })

  it('refuses to guess when a base path cannot be read', async () => {
    const draft = draftOf([updateOp()])

    await expect(
      readForgePatchPreviewDiff(draft, sourceOf({ 'src/a.ts': { kind: 'unavailable' } }))
    ).resolves.toEqual({ ok: false, reason: 'base-unavailable' })
    await expect(
      readForgePatchPreviewDiff(
        draft,
        sourceOf({ 'src/a.ts': { kind: 'unsupported', why: 'binary' } })
      )
    ).resolves.toEqual({ ok: false, reason: 'base-unsupported' })
  })

  it('refuses a base that no longer hashes to the approved one', async () => {
    const draft = draftOf([updateOp()])

    await expect(
      readForgePatchPreviewDiff(draft, sourceOf({ 'src/a.ts': 'tampered\n' }))
    ).resolves.toEqual({ ok: false, reason: 'base-mismatch' })
  })

  it('needs the base for a deletion and refuses when the path is absent', async () => {
    const draft = draftOf([
      { op: 'delete', path: 'gone.ts', baseSha256: sha256OfContent('gone\n') }
    ])

    await expect(readForgePatchPreviewDiff(draft, sourceOf({}))).resolves.toEqual({
      ok: false,
      reason: 'base-missing'
    })
  })
})

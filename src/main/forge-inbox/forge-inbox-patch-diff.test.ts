import { describe, expect, it } from 'vitest'
import {
  buildForgePatchDraft,
  sha256OfContent,
  type ForgePatchDraft,
  type ForgePatchOperation
} from './forge-inbox-patch-draft'
import { renderForgePatchDiff } from './forge-inbox-patch-diff'

const BASE = 'a'.repeat(40)
const TARGET = { instanceId: 'gitlab-main', projectId: '42' }

function draftOf(operations: ForgePatchOperation[]): ForgePatchDraft {
  const built = buildForgePatchDraft({ target: TARGET, baseSha: BASE, branch: 'main', operations })
  if (!built.ok) {
    throw new Error(`draft rejected: ${built.reason}`)
  }
  return built.draft
}

describe('forge patch diff', () => {
  it('renders a created file as a new file with its full content', () => {
    const draft = draftOf([
      {
        op: 'create',
        path: 'src/new.ts',
        content: 'export const a = 1\n',
        resultSha256: sha256OfContent('export const a = 1\n')
      }
    ])

    const diff = renderForgePatchDiff(draft, () => null)

    expect(diff.ok).toBe(true)
    if (!diff.ok) {
      return
    }
    expect(diff.text).toContain('--- /dev/null')
    expect(diff.text).toContain('+++ b/src/new.ts')
    expect(diff.text).toContain('+export const a = 1')
  })

  it('renders an update against the exact base content', () => {
    const base = 'one\ntwo\nthree\n'
    const draft = draftOf([
      {
        op: 'update',
        path: 'a.txt',
        baseSha256: sha256OfContent(base),
        content: 'one\nTWO\nthree\n',
        resultSha256: sha256OfContent('one\nTWO\nthree\n')
      }
    ])

    const diff = renderForgePatchDiff(draft, (path) => (path === 'a.txt' ? base : null))

    expect(diff).toMatchObject({ ok: true })
    if (!diff.ok) {
      return
    }
    expect(diff.text).toContain('-two')
    expect(diff.text).toContain('+TWO')
  })

  it('renders deletion as an empty file', () => {
    const base = 'gone\n'
    const draft = draftOf([{ op: 'delete', path: 'old.txt', baseSha256: sha256OfContent(base) }])

    const diff = renderForgePatchDiff(draft, () => base)

    expect(diff).toMatchObject({ ok: true })
    if (!diff.ok) {
      return
    }
    expect(diff.text).toContain('+++ /dev/null')
    expect(diff.text).toContain('-gone')
  })

  it('refuses a create whose path already exists', () => {
    const draft = draftOf([
      { op: 'create', path: 'a.ts', content: 'x\n', resultSha256: sha256OfContent('x\n') }
    ])

    expect(renderForgePatchDiff(draft, () => 'existing\n')).toEqual({
      ok: false,
      reason: 'base-unexpected'
    })
  })

  it('refuses an update or delete whose base is missing', () => {
    const update = draftOf([
      {
        op: 'update',
        path: 'a.ts',
        baseSha256: sha256OfContent('old\n'),
        content: 'new\n',
        resultSha256: sha256OfContent('new\n')
      }
    ])
    const remove = draftOf([{ op: 'delete', path: 'a.ts', baseSha256: sha256OfContent('old\n') }])

    expect(renderForgePatchDiff(update, () => null)).toEqual({ ok: false, reason: 'base-missing' })
    expect(renderForgePatchDiff(remove, () => null)).toEqual({ ok: false, reason: 'base-missing' })
  })

  it('refuses to display a diff over a base that does not match the approved hash', () => {
    const draft = draftOf([
      {
        op: 'update',
        path: 'a.ts',
        baseSha256: sha256OfContent('approved\n'),
        content: 'new\n',
        resultSha256: sha256OfContent('new\n')
      }
    ])

    expect(renderForgePatchDiff(draft, () => 'someone else changed this\n')).toEqual({
      ok: false,
      reason: 'base-mismatch'
    })
  })

  it('refuses a diff larger than the display budget instead of truncating it', () => {
    const content = 'x'.repeat(200 * 1024)
    const draft = draftOf(
      ['a.bin', 'b.bin', 'c.bin'].map((path) => ({
        op: 'create' as const,
        path,
        content,
        resultSha256: sha256OfContent(content)
      }))
    )

    expect(renderForgePatchDiff(draft, () => null)).toEqual({ ok: false, reason: 'diff-too-large' })
  })

  it('renders every operation in canonical order', () => {
    const base = 'old\n'
    const draft = draftOf([
      { op: 'create', path: 'b.ts', content: 'b\n', resultSha256: sha256OfContent('b\n') },
      { op: 'delete', path: 'a.ts', baseSha256: sha256OfContent(base) }
    ])

    const diff = renderForgePatchDiff(draft, (path) => (path === 'a.ts' ? base : null))

    expect(diff).toMatchObject({ ok: true })
    if (!diff.ok) {
      return
    }
    expect(diff.text.indexOf('a.ts')).toBeLessThan(diff.text.indexOf('b.ts'))
  })
})

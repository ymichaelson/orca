import { describe, expect, it } from 'vitest'
import {
  buildForgePatchDraft,
  sha256OfContent,
  type ForgePatchDraft,
  type ForgePatchOperation
} from './forge-inbox-patch-draft'
import {
  buildForgePushTree,
  type ForgePushBaseEntry,
  type ForgePushTreeResult
} from './forge-inbox-git-push-tree'

const HELLO = 'ce013625030ba8dba906f756967f9e9ca394464a'
const WORLD = 'cc628ccd10742baea8241c5924df992b5c019f71'
const TREE_WORLD = '721eea743f274b162a059c0032155c36a62cd740'
const BASE = 'a'.repeat(40)
const TARGET = { instanceId: 'gitlab-main', projectId: '42' }

function blob(path: string, id: string, mode = '100644'): ForgePushBaseEntry {
  return { path, type: 'blob', mode, id }
}

function tree(path: string, id: string): ForgePushBaseEntry {
  return { path, type: 'tree', mode: '040000', id }
}

function draftOf(operations: ForgePatchOperation[]): ForgePatchDraft {
  const built = buildForgePatchDraft({ target: TARGET, baseSha: BASE, branch: 'main', operations })
  if (!built.ok) {
    throw new Error(`draft rejected: ${built.reason}`)
  }
  return built.draft
}

function update(path: string, before: string, after: string): ForgePatchOperation {
  return {
    op: 'update',
    path,
    baseSha256: sha256OfContent(before),
    content: after,
    resultSha256: sha256OfContent(after)
  }
}

function create(path: string, content: string): ForgePatchOperation {
  return { op: 'create', path, content, resultSha256: sha256OfContent(content) }
}

function expectTree(result: ForgePushTreeResult): Extract<ForgePushTreeResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`unexpected failure ${result.reason}`)
  }
  return result
}

describe('forge push tree', () => {
  it('rebuilds the root tree for an updated file', () => {
    const result = expectTree(
      buildForgePushTree({
        entries: [blob('a.txt', HELLO)],
        draft: draftOf([update('a.txt', 'hello\n', 'world\n')])
      })
    )

    expect(result.rootTree).toBe('37be64009ef66e880e17a5e96449ee55cbfd7d48')
  })

  it('adds a new subtree for a created file', () => {
    const result = expectTree(
      buildForgePushTree({
        entries: [blob('a.txt', HELLO)],
        draft: draftOf([create('src/b.txt', 'world\n')])
      })
    )

    expect(result.rootTree).toBe('18a12043ddb2b1ef24869e1e2f4a615de0db2721')
  })

  it('drops a deleted file and reuses untouched subtrees by their published id', () => {
    const result = expectTree(
      buildForgePushTree({
        entries: [tree('src', TREE_WORLD), blob('src/b.txt', WORLD), blob('readme.md', HELLO)],
        draft: draftOf([
          { op: 'delete', path: 'readme.md', baseSha256: sha256OfContent('hello\n') }
        ])
      })
    )

    expect(result.rootTree).toBe('3af6ecb4215a053b2ff6b0dd580659e1fa36dab4')
    expect(result.objects.filter((object) => object.type === 'tree')).toHaveLength(1)
  })

  it('keeps the executable bit of an updated file', () => {
    const result = expectTree(
      buildForgePushTree({
        entries: [blob('run.sh', HELLO, '100755')],
        draft: draftOf([update('run.sh', 'hello\n', 'world\n')])
      })
    )

    const serialized = result.objects
      .filter((object) => object.type === 'tree')
      .map((object) => object.content.toString('latin1'))
      .join('')
    expect(serialized).toContain(
      `100755 run.sh\u0000${Buffer.from(WORLD, 'hex').toString('latin1')}`
    )
  })

  it('creates parents for a nested new path', () => {
    const result = expectTree(
      buildForgePushTree({
        entries: [],
        draft: draftOf([create('a/b/c.txt', 'x\n')])
      })
    )

    const trees = result.objects.filter((object) => object.type === 'tree')
    expect(trees).toHaveLength(3)
    expect(trees.map((object) => object.oid)).toContain(result.rootTree)
  })

  it.each([
    ['a submodule', { path: 'a.txt', type: 'commit', mode: '160000', id: HELLO }],
    ['a symlink', { path: 'a.txt', type: 'blob', mode: '120000', id: HELLO }],
    ['an unreadable mode', { path: 'a.txt', type: 'blob', mode: '100664', id: HELLO }]
  ] as const)('refuses %s in the base', (_label, entry) => {
    expect(
      buildForgePushTree({ entries: [entry], draft: draftOf([create('b.txt', 'x\n')]) })
    ).toEqual({ ok: false, reason: 'base-unsupported-object' })
  })

  it('refuses a sha256 object id instead of guessing the repository format', () => {
    expect(
      buildForgePushTree({
        entries: [blob('a.txt', 'a'.repeat(64))],
        draft: draftOf([create('b.txt', 'x\n')])
      })
    ).toEqual({ ok: false, reason: 'base-unsupported-hash' })
  })

  it.each([
    ['a duplicate path', [blob('a.txt', HELLO), blob('a.txt', WORLD)]],
    ['an unsafe path', [blob('../a.txt', HELLO)]],
    ['a file that also has children', [blob('a', HELLO), blob('a/b.txt', WORLD)]]
  ] as const)('refuses %s in the base', (_label, entries) => {
    expect(
      buildForgePushTree({ entries: [...entries], draft: draftOf([create('c.txt', 'x\n')]) })
    ).toEqual({ ok: false, reason: 'base-entry-invalid' })
  })

  it('refuses an operation that does not match the pinned base', () => {
    const entries = [blob('a.txt', HELLO)]
    const created = draftOf([create('a.txt', 'x\n')])
    const updated = draftOf([update('missing.txt', 'old\n', 'new\n')])
    const deleted = draftOf([{ op: 'delete', path: 'src', baseSha256: sha256OfContent('old\n') }])

    expect(buildForgePushTree({ entries, draft: created })).toEqual({
      ok: false,
      reason: 'operation-target-conflict'
    })
    expect(buildForgePushTree({ entries, draft: updated })).toEqual({
      ok: false,
      reason: 'operation-target-conflict'
    })
    expect(buildForgePushTree({ entries: [tree('src', TREE_WORLD)], draft: deleted })).toEqual({
      ok: false,
      reason: 'operation-target-conflict'
    })
  })

  it.each(['a', 'A'])('refuses a created child beneath base blob %s', (path) => {
    expect(
      buildForgePushTree({
        entries: [blob(path, HELLO)],
        draft: draftOf([create('a/b.txt', 'world\n')])
      })
    ).toEqual({ ok: false, reason: 'operation-target-conflict' })
  })

  it.each(['create', 'update'] as const)('refuses to %s over a base directory', (op) => {
    const operation = op === 'create' ? create('src', 'x\n') : update('src', 'old\n', 'new\n')
    expect(
      buildForgePushTree({
        entries: [tree('src', TREE_WORLD), blob('src/b.txt', WORLD)],
        draft: draftOf([operation])
      })
    ).toEqual({ ok: false, reason: 'operation-target-conflict' })
  })

  it.each([
    { entries: [blob('A.txt', HELLO)], path: 'a.txt' },
    { entries: [blob('σ.txt', HELLO)], path: 'ς.txt' },
    { entries: [tree('SRC', TREE_WORLD), blob('SRC/b.txt', WORLD)], path: 'src/c.txt' },
    { entries: [blob('café.txt', HELLO)], path: 'café.txt' }
  ])('refuses a create at $path aliasing a base entry', ({ entries, path }) => {
    expect(buildForgePushTree({ entries, draft: draftOf([create(path, 'x\n')]) })).toEqual({
      ok: false,
      reason: 'operation-target-conflict'
    })
  })

  it('does not omit an operation when a dirty subtree cannot be serialized', () => {
    expect(
      buildForgePushTree({
        entries: [blob('src/A.txt', HELLO), blob('src/a.txt', WORLD)],
        draft: draftOf([create('src/b.txt', 'x\n')])
      })
    ).toEqual({ ok: false, reason: 'tree-invalid' })
  })

  it('preserves untouched nonportable base names while including every portable change', () => {
    const result = expectTree(
      buildForgePushTree({
        entries: [blob('CON', HELLO), blob('café.txt', WORLD)],
        draft: draftOf([create('café/new.txt', '﻿new 😀\n'), create('other.txt', 'other\n')])
      })
    )
    const root = result.objects.find((object) => object.oid === result.rootTree)
    expect(root?.content.includes(Buffer.from(`100644 CON\u0000`, 'utf8'))).toBe(true)
    expect(root?.content.includes(Buffer.from(`100644 café.txt\u0000`, 'utf8'))).toBe(true)
    expect(root?.content.includes(Buffer.from('40000 café\u0000', 'utf8'))).toBe(true)
    expect(root?.content.includes(Buffer.from('100644 other.txt\u0000', 'utf8'))).toBe(true)
    expect(result.objects.some((object) => object.content.equals(Buffer.from('﻿new 😀\n')))).toBe(
      true
    )
    expect(
      result.objects.some(
        (object) =>
          object.type === 'tree' && object.content.includes(Buffer.from('100644 new.txt\u0000'))
      )
    ).toBe(true)
  })

  it('refuses case-folded siblings rather than emitting a tree git cannot check out', () => {
    expect(
      buildForgePushTree({
        entries: [blob('README.md', HELLO), blob('readme.md', WORLD)],
        draft: draftOf([create('a.txt', 'x\n')])
      })
    ).toEqual({ ok: false, reason: 'tree-invalid' })
  })

  it('refuses a path deeper than the object budget allows', () => {
    const deep = Array.from({ length: 65 }, (_value, index) => `d${index}`).join('/')

    expect(
      buildForgePushTree({
        entries: [blob(deep, HELLO)],
        draft: draftOf([create('a.txt', 'x\n')])
      })
    ).toEqual({ ok: false, reason: 'path-too-deep' })
  })
})

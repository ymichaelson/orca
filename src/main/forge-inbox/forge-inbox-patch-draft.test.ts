import { describe, expect, it } from 'vitest'
import {
  buildForgePatchDraft,
  FORGE_PATCH_MAX_FILE_BYTES,
  FORGE_PATCH_MAX_OPERATIONS,
  hashForgePatchDraft,
  parseForgePatchDraft,
  sha256OfContent,
  type ForgePatchOperation
} from './forge-inbox-patch-draft'

const BASE = 'a'.repeat(40)
const TARGET = { instanceId: 'gitlab-main', projectId: '42' }

function update(path: string, content: string, baseContent = 'old\n'): ForgePatchOperation {
  return {
    op: 'update',
    path,
    baseSha256: sha256OfContent(baseContent),
    content,
    resultSha256: sha256OfContent(content)
  }
}

function create(path: string, content: string): ForgePatchOperation {
  return { op: 'create', path, content, resultSha256: sha256OfContent(content) }
}

function build(
  operations: ForgePatchOperation[],
  overrides: { target?: typeof TARGET; baseSha?: string; branch?: string } = {}
) {
  return buildForgePatchDraft({
    target: TARGET,
    baseSha: BASE,
    branch: 'main',
    operations,
    ...overrides
  })
}

describe('forge patch draft', () => {
  it('stores a canonical, sorted manifest and a stable hash', () => {
    const first = build([update('b.ts', 'new b\n'), create('a.ts', 'a\n')])
    const second = build([create('a.ts', 'a\n'), update('b.ts', 'new b\n')])
    if (!first.ok || !second.ok) {
      throw new Error(`unexpected refusal ${JSON.stringify(first)}`)
    }

    expect(first.draft.operations.map((operation) => operation.path)).toEqual(['a.ts', 'b.ts'])
    expect(first.hash).toBe(second.hash)
    expect(first.hash).toBe(hashForgePatchDraft(first.draft))
    expect(parseForgePatchDraft(first.draft)?.operations).toHaveLength(2)
  })

  it.each([
    ['absolute', '/etc/passwd'],
    ['parent', 'src/../../etc/passwd'],
    ['dot segment', 'src/./a.ts'],
    ['empty segment', 'src//a.ts'],
    ['trailing slash', 'src/'],
    ['backslash', 'src\\a.ts'],
    ['git directory', 'src/.git/config'],
    ['git directory uppercase', 'src/.GIT/config'],
    ['control character', 'src/a\u0007.ts']
  ])('rejects a %s path', (_label, path) => {
    expect(build([create(path, 'x\n')])).toEqual({ ok: false, reason: 'path-invalid' })
  })

  it.each([
    'CON',
    'src/con.txt',
    'PRN',
    'AUX',
    'NUL.log',
    'CONIN$',
    'CONOUT$.txt',
    'CLOCK$',
    'COM1.log',
    'COM¹',
    'LPT².txt',
    'src/file:stream',
    'src/question?.txt',
    'src/star*.txt',
    'src/less<.txt',
    'src/greater>.txt',
    'src/quote".txt',
    'src/pipe|.txt',
    'src/trailing.',
    'src/trailing ',
    'src/git~1/config',
    'src/.g‌it/config',
    'CON .txt',
    'NUL .log',
    'COM1 .txt',
    'café.txt',
    'src/\ud800.txt',
    'src/\udc00.txt',
    `src/${'é'.repeat(128)}`
  ])('rejects a nonportable operation path %j', (path) => {
    expect(build([create(path, 'x\n')])).toEqual({ ok: false, reason: 'path-invalid' })
  })

  it.each(['plain/file.txt', 'café/日本語😀.txt', `src/${'é'.repeat(127)}a`])(
    'keeps portable path %j and UTF-8 content unchanged',
    (path) => {
      const content = '﻿café 😀\n'
      const operation = create(path, content)
      const result = build([operation])
      expect(result).toMatchObject({ ok: true, draft: { operations: [operation] } })
    }
  )

  it.each(['\ud800', '\udc00', 'before\ud800after'])(
    'rejects content that UTF-8 would replace %j',
    (content) => {
      expect(build([create('a.txt', content)])).toEqual({ ok: false, reason: 'content-binary' })
    }
  )

  it.each([
    ['a', 'a/b.txt'],
    ['a/b.txt', 'a'],
    ['A', 'a/b.txt'],
    ['a/b.txt', 'A']
  ])('rejects ancestor operation paths %s and %s', (first, second) => {
    expect(build([create(first, 'a\n'), create(second, 'b\n')])).toEqual({
      ok: false,
      reason: 'duplicate-path'
    })
  })

  it('rejects overlapping delete and create operations', () => {
    expect(
      build([
        { op: 'delete', path: 'a', baseSha256: sha256OfContent('old\n') },
        create('a/b.txt', 'new\n')
      ])
    ).toEqual({ ok: false, reason: 'duplicate-path' })
  })

  it('rejects two paths that differ only in case', () => {
    expect(build([create('src/A.ts', 'a\n'), create('src/a.ts', 'b\n')])).toEqual({
      ok: false,
      reason: 'duplicate-path'
    })
  })

  it.each([
    ['σ.txt', 'ς.txt'],
    ['I.txt', 'ı.txt'],
    ['ﬀ.txt', 'ff.txt']
  ])('rejects paths that collide only under full case folding: %s and %s', (first, second) => {
    expect(build([create(first, 'a\n'), create(second, 'b\n')])).toEqual({
      ok: false,
      reason: 'duplicate-path'
    })
  })

  it('keeps the sharp s colliding with its uppercase form', () => {
    expect(build([create('ẞ.txt', 'a\n'), create('ß.txt', 'b\n')])).toEqual({
      ok: false,
      reason: 'duplicate-path'
    })
  })

  it('rejects a result hash that does not match the content', () => {
    const tampered: ForgePatchOperation = {
      op: 'create',
      path: 'a.ts',
      content: 'changed\n',
      resultSha256: sha256OfContent('original\n')
    }
    expect(build([tampered])).toEqual({ ok: false, reason: 'result-hash-mismatch' })
  })

  it('rejects malformed hashes and a malformed base commit', () => {
    expect(
      build([{ op: 'delete', path: 'a.ts', baseSha256: sha256OfContent('x').toUpperCase() }])
    ).toEqual({ ok: false, reason: 'hash-invalid' })
    expect(build([create('a.ts', 'x\n')], { baseSha: 'not-a-sha' })).toEqual({
      ok: false,
      reason: 'base-invalid'
    })
    expect(build([create('a.ts', 'x\n')], { baseSha: 'A'.repeat(40) })).toEqual({
      ok: false,
      reason: 'base-invalid'
    })
  })

  it('rejects NUL content as binary', () => {
    expect(build([create('a.ts', 'a\u0000b')])).toEqual({ ok: false, reason: 'content-binary' })
  })

  it('enforces the per-file, total and operation caps', () => {
    const big = 'x'.repeat(FORGE_PATCH_MAX_FILE_BYTES + 1)
    expect(build([create('a.ts', big)])).toEqual({ ok: false, reason: 'content-too-large' })

    // Each file stays under its own cap; together they exceed the total budget.
    const each = 'x'.repeat(FORGE_PATCH_MAX_FILE_BYTES - 1024)
    const five = Array.from({ length: 5 }, (_, index) => create(`f${index}.ts`, each))
    expect(build(five)).toEqual({ ok: false, reason: 'total-too-large' })

    const many = Array.from({ length: FORGE_PATCH_MAX_OPERATIONS + 1 }, (_, index) =>
      create(`f${index}.ts`, 'x\n')
    )
    expect(build(many)).toEqual({ ok: false, reason: 'operations-too-many' })
    expect(build([])).toEqual({ ok: false, reason: 'operations-empty' })
  })

  it.each(['main', 'feat/gitlab-inbox', 'release/2026.10'])('accepts the branch %s', (branch) => {
    expect(build([create('a.ts', 'x\n')], { branch })).toMatchObject({ ok: true })
  })

  it.each([
    '-x',
    '/main',
    'main/',
    'main.',
    'main.lock',
    'feat//x',
    'feat/../x',
    'feat/.hidden',
    'feat/x.lock',
    'feat/x y',
    'feat/x~1',
    'feat/x^',
    'feat/x:1',
    'feat/x?',
    'feat/x*',
    'feat/x[1]',
    'feat/x\\y',
    '@',
    'feat/x@{1}'
  ])('rejects the branch %s', (branch) => {
    expect(build([create('a.ts', 'x\n')], { branch })).toEqual({
      ok: false,
      reason: 'branch-invalid'
    })
  })

  it('refuses to parse anything that is not exactly a patch manifest', () => {
    const built = build([create('a.ts', 'x\n')])
    if (!built.ok) {
      throw new Error('draft rejected')
    }
    expect(parseForgePatchDraft({ ...built.draft, kind: 'comment' })).toBeNull()
    expect(parseForgePatchDraft({ ...built.draft, extra: true })).toBeNull()
    const operations = built.draft.operations.map((operation) =>
      operation.op === 'create' ? { ...operation, content: 'tampered\n' } : operation
    )
    expect(parseForgePatchDraft({ ...built.draft, operations })).toBeNull()
  })
})

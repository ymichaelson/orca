import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildForgePatchDraft,
  sha256OfContent,
  type ForgePatchDraft,
  type ForgePatchOperation
} from './forge-inbox-patch-draft'
import {
  applyForgePatchInIsolation,
  type ForgePatchPathContent,
  type ForgePatchSource
} from './forge-inbox-patch-tree'

const BASE = 'a'.repeat(40)
const TARGET = { instanceId: 'gitlab-main', projectId: '42' }

function draftOf(operations: ForgePatchOperation[]): ForgePatchDraft {
  const built = buildForgePatchDraft({ target: TARGET, baseSha: BASE, branch: 'main', operations })
  if (!built.ok) {
    throw new Error(`draft rejected: ${built.reason}`)
  }
  return built.draft
}

function sourceOf(paths: Record<string, ForgePatchPathContent>): ForgePatchSource {
  return {
    readPath: async (path) => paths[path] ?? { kind: 'missing' }
  }
}

describe('forge patch isolated tree', () => {
  let parent: string

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'forge-patch-parent-'))
  })
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true })
  })

  function apply(draft: ForgePatchDraft, source: ForgePatchSource, signal?: AbortSignal) {
    return applyForgePatchInIsolation(
      { source, parentDirectory: parent, ...(signal ? { signal } : {}) },
      draft
    )
  }

  it('writes created and updated files and deletes removed ones in a private directory', async () => {
    const draft = draftOf([
      {
        op: 'create',
        path: 'src/new.ts',
        content: 'new\n',
        resultSha256: sha256OfContent('new\n')
      },
      {
        op: 'update',
        path: 'src/old.ts',
        baseSha256: sha256OfContent('old\n'),
        content: 'changed\n',
        resultSha256: sha256OfContent('changed\n')
      },
      { op: 'delete', path: 'src/gone.ts', baseSha256: sha256OfContent('gone\n') }
    ])

    const result = await apply(
      draft,
      sourceOf({
        'src/old.ts': { kind: 'file', content: 'old\n' },
        'src/gone.ts': { kind: 'file', content: 'gone\n' }
      })
    )

    if (!result.ok) {
      throw new Error(`unexpected refusal ${result.reason}`)
    }
    expect(statSync(result.directory).mode & 0o777).toBe(0o700)
    expect(readFileSync(join(result.directory, 'src/new.ts'), 'utf8')).toBe('new\n')
    expect(readFileSync(join(result.directory, 'src/old.ts'), 'utf8')).toBe('changed\n')
    expect(readdirSync(join(result.directory, 'src'))).toEqual(['new.ts', 'old.ts'])
    expect(result.written).toEqual(['src/new.ts', 'src/old.ts'])
    expect(result.removed).toEqual(['src/gone.ts'])
  })

  it('leaves the project directory untouched', async () => {
    writeFileSync(join(parent, 'keep.txt'), 'keep\n')
    const draft = draftOf([
      { op: 'create', path: 'a.ts', content: 'a\n', resultSha256: sha256OfContent('a\n') }
    ])

    const result = await apply(draft, sourceOf({}))

    expect(result).toMatchObject({ ok: true })
    expect(readFileSync(join(parent, 'keep.txt'), 'utf8')).toBe('keep\n')
    const entries = readdirSync(parent)
    expect(entries).toContain('keep.txt')
    expect(entries.filter((name) => name.startsWith('forge-patch-'))).toHaveLength(1)
  })

  it('refuses when the pinned base content no longer matches the approved hash', async () => {
    const draft = draftOf([
      {
        op: 'update',
        path: 'a.ts',
        baseSha256: sha256OfContent('approved\n'),
        content: 'new\n',
        resultSha256: sha256OfContent('new\n')
      }
    ])

    await expect(
      apply(draft, sourceOf({ 'a.ts': { kind: 'file', content: 'someone else\n' } }))
    ).resolves.toEqual({ ok: false, reason: 'base-mismatch' })
    expect(readdirSync(parent)).toEqual([])
  })

  it('refuses a create whose path already exists', async () => {
    const draft = draftOf([
      { op: 'create', path: 'a.ts', content: 'a\n', resultSha256: sha256OfContent('a\n') }
    ])

    await expect(
      apply(draft, sourceOf({ 'a.ts': { kind: 'file', content: 'existing\n' } }))
    ).resolves.toEqual({ ok: false, reason: 'base-unexpected' })
  })

  it('refuses an update or delete whose base is missing', async () => {
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

    await expect(apply(update, sourceOf({}))).resolves.toEqual({
      ok: false,
      reason: 'base-missing'
    })
    await expect(apply(remove, sourceOf({}))).resolves.toEqual({
      ok: false,
      reason: 'base-missing'
    })
  })

  it.each(['link', 'submodule', 'binary', 'too-large', 'non-blob'] as const)(
    'refuses a %s base instead of copying it',
    async (why) => {
      const draft = draftOf([
        {
          op: 'update',
          path: 'a.ts',
          baseSha256: sha256OfContent('old\n'),
          content: 'new\n',
          resultSha256: sha256OfContent('new\n')
        }
      ])

      await expect(
        apply(draft, sourceOf({ 'a.ts': { kind: 'unsupported', why } }))
      ).resolves.toEqual({ ok: false, reason: 'base-unsupported' })
    }
  )

  it('refuses when the pinned base cannot be read at all', async () => {
    const draft = draftOf([
      { op: 'create', path: 'a.ts', content: 'a\n', resultSha256: sha256OfContent('a\n') }
    ])

    await expect(apply(draft, sourceOf({ 'a.ts': { kind: 'unavailable' } }))).resolves.toEqual({
      ok: false,
      reason: 'source-unavailable'
    })
  })

  it('refuses to start once the run was cancelled', async () => {
    const draft = draftOf([
      { op: 'create', path: 'a.ts', content: 'a\n', resultSha256: sha256OfContent('a\n') }
    ])
    const controller = new AbortController()
    controller.abort()

    await expect(apply(draft, sourceOf({}), controller.signal)).resolves.toEqual({
      ok: false,
      reason: 'aborted'
    })
    expect(readdirSync(parent)).toEqual([])
  })

  it('refuses when the private directory cannot be created', async () => {
    const draft = draftOf([
      { op: 'create', path: 'a.ts', content: 'a\n', resultSha256: sha256OfContent('a\n') }
    ])

    await expect(
      applyForgePatchInIsolation(
        { source: sourceOf({}), parentDirectory: join(parent, 'missing') },
        draft
      )
    ).resolves.toEqual({ ok: false, reason: 'write-failed' })
  })
})

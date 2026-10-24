import { describe, expect, it } from 'vitest'
import type { GitlabDiffFile } from './forge-inbox-gitlab-api-schemas'
import { sha256OfContent } from './forge-inbox-patch-draft'
import { forgePatchPathsFromDiffs, readForgePatchContext } from './forge-inbox-patch-context'
import type { ForgePatchPathContent, ForgePatchSource } from './forge-inbox-patch-tree'

const KIB = 1024

function diff(overrides: Partial<GitlabDiffFile> = {}): GitlabDiffFile {
  return {
    old_path: 'src/modified.ts',
    new_path: 'src/modified.ts',
    diff: '',
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    generated_file: false,
    ...overrides
  }
}

function source(entries: Record<string, ForgePatchPathContent>): ForgePatchSource {
  return {
    readPath: async (path) => entries[path] ?? { kind: 'missing' }
  }
}

describe('forge patch paths from diffs', () => {
  it('reads modified, added, and deleted paths from their current name', () => {
    expect(
      forgePatchPathsFromDiffs([
        diff(),
        diff({ old_path: 'unused.ts', new_path: 'src/added.ts', new_file: true }),
        diff({ old_path: 'src/removed.ts', new_path: 'src/renamed-away.ts', deleted_file: true })
      ])
    ).toEqual(['src/modified.ts', 'src/added.ts', 'src/removed.ts'])
  })

  it('deduplicates paths that differ only by case', () => {
    expect(
      forgePatchPathsFromDiffs([
        diff({ old_path: 'src/A.ts', new_path: 'src/A.ts' }),
        diff({ old_path: 'src/a.ts', new_path: 'src/a.ts' })
      ])
    ).toEqual(['src/A.ts'])
  })

  it('refuses an empty diff set', () => {
    expect(forgePatchPathsFromDiffs([])).toBeNull()
  })

  it('refuses more than 32 distinct paths', () => {
    expect(
      forgePatchPathsFromDiffs(
        Array.from({ length: 33 }, (_, index) =>
          diff({ old_path: `src/file-${index}.ts`, new_path: `src/file-${index}.ts` })
        )
      )
    ).toBeNull()
  })

  it('refuses a path that cannot be operated on portably', () => {
    expect(
      forgePatchPathsFromDiffs([diff({ old_path: '../escape.ts', new_path: '../escape.ts' })])
    ).toBeNull()
  })

  it('refuses a path that aliases the worktree control directory', () => {
    expect(
      forgePatchPathsFromDiffs([diff({ old_path: 'src/.git/config', new_path: 'src/.git/config' })])
    ).toBeNull()
  })
})

describe('forge patch context reading', () => {
  it('returns file content with its base hash and marks a proven absence', async () => {
    await expect(
      readForgePatchContext({
        source: source({ 'src/a.ts': { kind: 'file', content: 'export const a = 1\n' } }),
        paths: ['src/a.ts', 'src/b.ts']
      })
    ).resolves.toEqual({
      ok: true,
      entries: [
        {
          path: 'src/a.ts',
          kind: 'file',
          content: 'export const a = 1\n',
          sha256: sha256OfContent('export const a = 1\n')
        },
        { path: 'src/b.ts', kind: 'missing' }
      ]
    })
  })

  it('refuses duplicate requested paths', async () => {
    await expect(
      readForgePatchContext({
        source: source({ 'src/a.ts': { kind: 'file', content: 'a' } }),
        paths: ['src/a.ts', 'src/a.ts']
      })
    ).resolves.toEqual({ ok: false, reason: 'context-duplicate' })
  })

  it('refuses paths that collide as aliases', async () => {
    await expect(
      readForgePatchContext({
        source: source({}),
        paths: ['src/A.ts', 'src/a.ts']
      })
    ).resolves.toEqual({ ok: false, reason: 'context-paths' })
  })

  it('refuses an invalid operation path', async () => {
    await expect(
      readForgePatchContext({ source: source({}), paths: ['../escape.ts'] })
    ).resolves.toEqual({ ok: false, reason: 'context-paths' })
  })

  it('refuses more than 32 paths', async () => {
    await expect(
      readForgePatchContext({
        source: source({}),
        paths: Array.from({ length: 33 }, (_, index) => `src/file-${index}.ts`)
      })
    ).resolves.toEqual({ ok: false, reason: 'context-paths' })
  })

  it('refuses an unsupported base entry', async () => {
    await expect(
      readForgePatchContext({
        source: source({ 'src/link.ts': { kind: 'unsupported', why: 'link' } }),
        paths: ['src/link.ts']
      })
    ).resolves.toEqual({ ok: false, reason: 'context-unsupported' })
  })

  it('refuses an unavailable base entry', async () => {
    await expect(
      readForgePatchContext({
        source: source({ 'src/a.ts': { kind: 'unavailable' } }),
        paths: ['src/a.ts']
      })
    ).resolves.toEqual({ ok: false, reason: 'context-unavailable' })
  })

  it('refuses context larger than one mebibyte', async () => {
    await expect(
      readForgePatchContext({
        source: source({
          'src/a.ts': { kind: 'file', content: 'a'.repeat(600 * KIB) },
          'src/b.ts': { kind: 'file', content: 'b'.repeat(600 * KIB) }
        }),
        paths: ['src/a.ts', 'src/b.ts']
      })
    ).resolves.toEqual({ ok: false, reason: 'context-too-large' })
  })
})

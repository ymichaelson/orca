import { describe, expect, it, vi } from 'vitest'
import type { GitlabApiReader } from './forge-inbox-gitlab-api-client'
import type { GitlabTreeEntry } from './forge-inbox-gitlab-api-schemas'
import { createGitlabPatchSource } from './forge-inbox-gitlab-patch-source'

const REF = 'a'.repeat(40)

function entry(overrides: Partial<GitlabTreeEntry> & { path: string }): GitlabTreeEntry {
  return {
    id: `id-${overrides.path}`,
    name: overrides.path,
    type: 'blob',
    mode: '100644',
    ...overrides
  }
}

function readerWith(
  tree: GitlabTreeEntry[] | null,
  files: Record<string, string> = {},
  complete = true
): Pick<GitlabApiReader, 'listRepositoryTree' | 'getRepositoryFile'> {
  return {
    listRepositoryTree: vi.fn(async () =>
      tree === null
        ? ({ ok: false, code: 'network' } as const)
        : ({ ok: true, data: tree, complete } as const)
    ),
    getRepositoryFile: vi.fn(async (_ref, path) => {
      const content = files[path]
      return content === undefined
        ? ({ ok: false, code: 'not-found' } as const)
        : ({ ok: true, data: content, complete: true } as const)
    })
  }
}

describe('forge patch gitlab source', () => {
  it('reads the reviewed blob at the pinned commit', async () => {
    const reader = readerWith([entry({ path: 'src/a.ts' })], { 'src/a.ts': 'old\n' })
    const source = createGitlabPatchSource({ reader, ref: REF })

    await expect(source.readPath('src/a.ts')).resolves.toEqual({ kind: 'file', content: 'old\n' })
    expect(reader.getRepositoryFile).toHaveBeenCalledWith(REF, 'src/a.ts')
  })

  it('caches one tree listing for every path it is asked about', async () => {
    const reader = readerWith([entry({ path: 'a.ts' }), entry({ path: 'b.ts' })], {
      'a.ts': 'a\n',
      'b.ts': 'b\n'
    })
    const source = createGitlabPatchSource({ reader, ref: REF })

    await source.readPath('a.ts')
    await source.readPath('b.ts')

    expect(reader.listRepositoryTree).toHaveBeenCalledTimes(1)
  })

  it('reports a path absent from a complete tree as missing', async () => {
    const source = createGitlabPatchSource({ reader: readerWith([]), ref: REF })

    await expect(source.readPath('a.ts')).resolves.toEqual({ kind: 'missing' })
  })

  it.each([
    ['a symlink', [entry({ path: 'a.ts', mode: '120000' })], 'link'],
    ['a submodule', [entry({ path: 'a.ts', type: 'commit', mode: '160000' })], 'submodule'],
    ['a directory', [entry({ path: 'a.ts', type: 'tree', mode: '040000' })], 'non-blob'],
    ['a duplicate path', [entry({ path: 'a.ts' }), entry({ path: 'a.ts' })], 'non-blob']
  ] as const)('refuses %s', async (_label, tree, why) => {
    const source = createGitlabPatchSource({ reader: readerWith([...tree]), ref: REF })

    await expect(source.readPath('a.ts')).resolves.toEqual({ kind: 'unsupported', why })
  })

  it('refuses binary and oversized blobs', async () => {
    const binary = createGitlabPatchSource({
      reader: readerWith([entry({ path: 'a.ts' })], { 'a.ts': 'a\u0000b' }),
      ref: REF
    })
    const large = createGitlabPatchSource({
      reader: readerWith([entry({ path: 'a.ts' })], { 'a.ts': 'x'.repeat(256 * 1024 + 1) }),
      ref: REF
    })

    await expect(binary.readPath('a.ts')).resolves.toEqual({ kind: 'unsupported', why: 'binary' })
    await expect(large.readPath('a.ts')).resolves.toEqual({ kind: 'unsupported', why: 'too-large' })
  })

  it('treats an incomplete tree as unavailable rather than guessing absence', async () => {
    const source = createGitlabPatchSource({
      reader: readerWith([entry({ path: 'b.ts' })], {}, false),
      ref: REF
    })

    await expect(source.readPath('a.ts')).resolves.toEqual({ kind: 'unavailable' })
  })

  it('treats a failed listing or blob read as unavailable', async () => {
    const failedTree = createGitlabPatchSource({ reader: readerWith(null), ref: REF })
    const failedBlob = createGitlabPatchSource({
      reader: readerWith([entry({ path: 'a.ts' })]),
      ref: REF
    })

    await expect(failedTree.readPath('a.ts')).resolves.toEqual({ kind: 'unavailable' })
    await expect(failedBlob.readPath('a.ts')).resolves.toEqual({ kind: 'unavailable' })
  })
})

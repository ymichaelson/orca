import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createGitlabApiReader, type GitlabApiReader } from './forge-inbox-gitlab-api-client'
import type { GitlabTreeEntry } from './forge-inbox-gitlab-api-schemas'
import { createForgeGitBlob } from './forge-inbox-git-objects'
import { createGitlabPatchSource } from './forge-inbox-gitlab-patch-source'
import {
  buildForgePatchDraft,
  FORGE_PATCH_MAX_FILE_BYTES,
  sha256OfContent
} from './forge-inbox-patch-draft'
import { applyForgePatchInIsolation } from './forge-inbox-patch-tree'

const REF = 'a'.repeat(40)

function entry(
  overrides: Partial<GitlabTreeEntry> & { path: string },
  content = 'old\n'
): GitlabTreeEntry {
  return {
    id: createForgeGitBlob(content).oid,
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
    const reader = readerWith([entry({ path: 'a.ts' }, 'a\n'), entry({ path: 'b.ts' }, 'b\n')], {
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

  it('reports a case alias as unavailable rather than missing', async () => {
    const source = createGitlabPatchSource({
      reader: readerWith([entry({ path: 'src/foo.ts' })]),
      ref: REF
    })

    await expect(source.readPath('src/Foo.ts')).resolves.toEqual({ kind: 'unavailable' })
  })

  it('reports a Unicode normalization alias as unavailable rather than missing', async () => {
    const source = createGitlabPatchSource({
      reader: readerWith([entry({ path: 'src/cafe\u0301.ts' })]),
      ref: REF
    })

    await expect(source.readPath('src/caf\u00e9.ts')).resolves.toEqual({ kind: 'unavailable' })
  })

  it('resolves the exact path when an alias also occupies the tree', async () => {
    const reader = readerWith(
      [entry({ path: 'src/foo.ts' }, 'lower\n'), entry({ path: 'src/Foo.ts' }, 'upper\n')],
      { 'src/foo.ts': 'lower\n', 'src/Foo.ts': 'upper\n' }
    )
    const source = createGitlabPatchSource({ reader, ref: REF })

    await expect(source.readPath('src/Foo.ts')).resolves.toEqual({
      kind: 'file',
      content: 'upper\n'
    })
    await expect(source.readPath('src/foo.ts')).resolves.toEqual({
      kind: 'file',
      content: 'lower\n'
    })
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

  it('refuses content whose canonical Git blob id differs from the pinned tree', async () => {
    const source = createGitlabPatchSource({
      reader: readerWith(
        [entry({ path: 'a.txt', id: 'ce013625030ba8dba906f756967f9e9ca394464a' })],
        {
          'a.txt': 'jello\n'
        }
      ),
      ref: REF
    })

    await expect(source.readPath('a.txt')).resolves.toEqual({ kind: 'unavailable' })
  })

  it('materializes nothing when the raw blob differs from the pinned tree despite an approved content hash', async () => {
    const source = createGitlabPatchSource({
      reader: readerWith(
        [entry({ path: 'z-existing.txt', id: 'ce013625030ba8dba906f756967f9e9ca394464a' })],
        { 'z-existing.txt': 'jello\n' }
      ),
      ref: REF
    })
    const draft = buildForgePatchDraft({
      target: { instanceId: 'gitlab-main', projectId: '42' },
      baseSha: REF,
      branch: 'main',
      operations: [
        {
          op: 'create',
          path: 'a-created.txt',
          content: 'created\n',
          resultSha256: sha256OfContent('created\n')
        },
        {
          op: 'update',
          path: 'z-existing.txt',
          baseSha256: sha256OfContent('jello\n'),
          content: 'updated\n',
          resultSha256: sha256OfContent('updated\n')
        }
      ]
    })
    if (!draft.ok) {
      throw new Error(`draft rejected: ${draft.reason}`)
    }
    const parentDirectory = mkdtempSync(join(tmpdir(), 'forge-source-exactness-'))
    try {
      const result = await applyForgePatchInIsolation({ source, parentDirectory }, draft.draft)

      expect(readdirSync(parentDirectory)).toEqual([])
      expect(result).toEqual({ ok: false, reason: 'source-unavailable' })
    } finally {
      rmSync(parentDirectory, { recursive: true, force: true })
    }
  })

  it('accepts a literal replacement character when its UTF-8 bytes match the tree', async () => {
    const content = '�\n'
    const source = createGitlabPatchSource({
      reader: readerWith([entry({ path: 'a.txt' }, content)], { 'a.txt': content }),
      ref: REF
    })

    await expect(source.readPath('a.txt')).resolves.toEqual({ kind: 'file', content })
  })

  it.each(['100600', '040000', '', '100644 '])(
    'refuses unsupported blob mode %j before fetching content',
    async (mode) => {
      const reader = readerWith([entry({ path: 'a.txt', mode })], { 'a.txt': 'old\n' })
      const source = createGitlabPatchSource({ reader, ref: REF })

      await expect(source.readPath('a.txt')).resolves.toEqual({
        kind: 'unsupported',
        why: 'non-blob'
      })
      expect(reader.getRepositoryFile).not.toHaveBeenCalled()
    }
  )

  it.each(['not-an-oid', 'A'.repeat(40), 'a'.repeat(64)])(
    'refuses an unsupported tree object id %j before fetching content',
    async (id) => {
      const reader = readerWith([entry({ path: 'a.txt', id })], { 'a.txt': 'old\n' })
      const source = createGitlabPatchSource({ reader, ref: REF })

      await expect(source.readPath('a.txt')).resolves.toEqual({ kind: 'unavailable' })
      expect(reader.getRepositoryFile).not.toHaveBeenCalled()
    }
  )

  it('does not accept an incomplete blob read even when its content hashes to the tree id', async () => {
    const reader = readerWith([entry({ path: 'a.txt' })])
    reader.getRepositoryFile = async () => ({ ok: true, data: 'old\n', complete: false })
    const source = createGitlabPatchSource({ reader, ref: REF })

    await expect(source.readPath('a.txt')).resolves.toEqual({ kind: 'unavailable' })
  })

  it.each(['main', 'A'.repeat(40), 'a'.repeat(64)])(
    'refuses an unpinned or unsupported base %j before reading',
    async (ref) => {
      const reader = readerWith([])
      const source = createGitlabPatchSource({ reader, ref })

      await expect(source.readPath('a.txt')).resolves.toEqual({ kind: 'unavailable' })
      expect(reader.listRepositoryTree).not.toHaveBeenCalled()
    }
  )

  it.each(['../a.txt', '/a.txt', 'a\\b.txt', 'a/../b.txt', '.git/config', ''])(
    'refuses an unsafe path %j before reading',
    async (path) => {
      const reader = readerWith([])
      const source = createGitlabPatchSource({ reader, ref: REF })

      await expect(source.readPath(path)).resolves.toEqual({ kind: 'unavailable' })
      expect(reader.listRepositoryTree).not.toHaveBeenCalled()
    }
  )

  it('refuses strings that cannot roundtrip as UTF-8 even when their replacement blob id matches', async () => {
    const content = String.fromCharCode(0xd800)
    const source = createGitlabPatchSource({
      reader: readerWith([entry({ path: 'a.txt' }, content)], { 'a.txt': content }),
      ref: REF
    })

    await expect(source.readPath('a.txt')).resolves.toEqual({
      kind: 'unsupported',
      why: 'binary'
    })
  })

  it.each(['100644', '100755'])(
    'accepts verified UTF-8 at the exact file byte limit with mode %s',
    async (mode) => {
      const content = 'é'.repeat(FORGE_PATCH_MAX_FILE_BYTES / 2)
      const source = createGitlabPatchSource({
        reader: readerWith([entry({ path: 'a.txt', mode }, content)], { 'a.txt': content }),
        ref: REF
      })

      await expect(source.readPath('a.txt')).resolves.toEqual({ kind: 'file', content })
    }
  )

  it.each([
    ['BOM and CRLF', Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0d, 0x0a]), true],
    ['malformed UTF-8', Buffer.from([0x80]), false],
    ['different raw bytes', Buffer.from('jello\n'), false]
  ] as const)(
    'verifies %s through the real bounded GitLab reader',
    async (_label, bytes, accepted) => {
      const expected = _label === 'different raw bytes' ? 'hello\n' : bytes.toString('utf8')
      const requests: URL[] = []
      const script = [
        new Response(JSON.stringify([entry({ path: 'a.txt' }, expected)])),
        new Response(bytes)
      ]
      const reader = createGitlabApiReader(
        {
          http: {
            fetch: async (url: string) => {
              requests.push(new URL(url))
              const response = script.shift()
              if (response === undefined) {
                throw new Error('unscripted request')
              }
              return response
            }
          },
          readToken: () => 'read-token',
          readConfigRevision: () => 1
        },
        { baseUrl: 'https://git.example.com', projectId: '42', expectedConfigRevision: 1 }
      )
      const source = createGitlabPatchSource({ reader, ref: REF })

      await expect(source.readPath('a.txt')).resolves.toEqual(
        accepted ? { kind: 'file', content: expected } : { kind: 'unavailable' }
      )
      expect(requests.map((url) => url.searchParams.get('ref'))).toEqual([REF, REF])
      expect(requests.map((url) => url.pathname)).toEqual([
        '/api/v4/projects/42/repository/tree',
        '/api/v4/projects/42/repository/files/a.txt/raw'
      ])
    }
  )

  it('refuses an approved create when the real reader skips a tree page', async () => {
    const requests: URL[] = []
    const script = [
      new Response(JSON.stringify([entry({ path: 'visible.txt' })]), {
        headers: { 'x-next-page': '3' }
      }),
      new Response('[]', { headers: { 'x-next-page': '' } })
    ]
    const reader = createGitlabApiReader(
      {
        http: {
          fetch: async (url: string) => {
            requests.push(new URL(url))
            const response = script.shift()
            if (response === undefined) {
              throw new Error('unscripted request')
            }
            return response
          }
        },
        readToken: () => 'read-token',
        readConfigRevision: () => 1
      },
      { baseUrl: 'https://git.example.com', projectId: '42', expectedConfigRevision: 1 }
    )
    const source = createGitlabPatchSource({ reader, ref: REF })
    const draft = buildForgePatchDraft({
      target: { instanceId: 'gitlab-main', projectId: '42' },
      baseSha: REF,
      branch: 'main',
      operations: [
        {
          op: 'create',
          path: 'hidden.txt',
          content: 'created\n',
          resultSha256: sha256OfContent('created\n')
        }
      ]
    })
    if (!draft.ok) {
      throw new Error(`draft rejected: ${draft.reason}`)
    }
    const parentDirectory = mkdtempSync(join(tmpdir(), 'forge-source-pagination-'))
    try {
      await expect.soft(source.readPath('hidden.txt')).resolves.toEqual({ kind: 'unavailable' })
      const result = await applyForgePatchInIsolation({ source, parentDirectory }, draft.draft)

      expect.soft(result).toEqual({ ok: false, reason: 'source-unavailable' })
      expect.soft(readdirSync(parentDirectory)).toEqual([])
      expect
        .soft(requests.map((url) => [url.pathname, url.searchParams.get('page')]))
        .toEqual([['/api/v4/projects/42/repository/tree', '1']])
    } finally {
      rmSync(parentDirectory, { recursive: true, force: true })
    }
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

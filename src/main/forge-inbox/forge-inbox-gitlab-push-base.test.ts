import { describe, expect, it, vi } from 'vitest'
import type { GitlabTreeEntry } from './forge-inbox-gitlab-api-schemas'
import {
  parseForgeGitlabCommitDate,
  readForgePushBase,
  type ForgePushBaseReader
} from './forge-inbox-gitlab-push-base'

const BASE = '61f87cf496fbb2f460a4f0dce1d72c2499f3843c'
const TREE = '2e81171448eb9f2ee3821e3d447aa6b2fe3ddba1'
const HELLO = 'ce013625030ba8dba906f756967f9e9ca394464a'

const ENTRIES: GitlabTreeEntry[] = [
  { id: HELLO, name: 'a.txt', type: 'blob', path: 'a.txt', mode: '100644' }
]

function commit(overrides: Record<string, unknown> = {}) {
  return {
    id: BASE,
    parent_ids: [],
    author_name: 'Orca',
    author_email: 'orca@example.com',
    authored_date: '2023-11-14T22:13:19.000+00:00',
    committer_name: 'Orca',
    committer_email: 'orca@example.com',
    committed_date: '2023-11-14T22:13:19.000+00:00',
    message: 'Base\n',
    ...overrides
  }
}

const BASE_COMMIT_TEXT =
  `tree ${TREE}\n` +
  'author Orca <orca@example.com> 1699999999 +0000\n' +
  'committer Orca <orca@example.com> 1699999999 +0000\n' +
  '\n' +
  'Base\n'

function reader(overrides: Partial<ForgePushBaseReader> = {}) {
  return {
    listRepositoryTree: vi.fn(async () => ({ ok: true as const, complete: true, data: ENTRIES })),
    getRepositoryCommit: vi.fn(async () => ({ ok: true as const, complete: true, data: commit() })),
    ...overrides
  }
}

describe('gitlab push base', () => {
  it('rebuilds the approved base commit byte for byte', async () => {
    const result = await readForgePushBase(
      { reader: reader(), expectedHeadSha: BASE },
      new AbortController().signal
    )

    if (!result.ok) {
      throw new Error(`unexpected failure ${result.reason}`)
    }
    expect(result.base.commit).toEqual({
      type: 'commit',
      oid: BASE,
      content: Buffer.from(BASE_COMMIT_TEXT, 'utf8')
    })
    expect(result.base.rootTree).toBe(TREE)
    expect(result.base.entries).toEqual(ENTRIES)
  })

  it('refuses metadata that does not hash to the approved head', async () => {
    const mismatched = reader({
      getRepositoryCommit: vi.fn(async () => ({
        ok: true as const,
        complete: true,
        data: commit({ message: 'Rewritten\n' })
      }))
    })

    await expect(
      readForgePushBase({ reader: mismatched, expectedHeadSha: BASE }, new AbortController().signal)
    ).resolves.toEqual({ ok: false, reason: 'base-unverified' })
  })

  it('refuses a parent list or a signed commit it cannot reproduce', async () => {
    const merged = reader({
      getRepositoryCommit: vi.fn(async () => ({
        ok: true as const,
        complete: true,
        data: commit({ parent_ids: ['a'.repeat(40)] })
      }))
    })
    const unsigned = reader({
      getRepositoryCommit: vi.fn(async () => ({
        ok: true as const,
        complete: true,
        data: commit({ message: 'Base\n-----BEGIN PGP SIGNATURE-----\n' })
      }))
    })

    await expect(
      readForgePushBase({ reader: merged, expectedHeadSha: BASE }, new AbortController().signal)
    ).resolves.toEqual({ ok: false, reason: 'base-unverified' })
    await expect(
      readForgePushBase({ reader: unsigned, expectedHeadSha: BASE }, new AbortController().signal)
    ).resolves.toEqual({ ok: false, reason: 'base-unverified' })
  })

  it('refuses an incomplete or unsupported listing before claiming a verified base', async () => {
    const incomplete = reader({
      listRepositoryTree: vi.fn(async () => ({
        ok: true as const,
        complete: false,
        data: ENTRIES
      }))
    })
    const submodule = reader({
      listRepositoryTree: vi.fn(async () => ({
        ok: true as const,
        complete: true,
        data: [
          {
            id: 'a'.repeat(40),
            name: 'vendor',
            type: 'commit' as const,
            path: 'vendor',
            mode: '160000'
          }
        ]
      }))
    })

    await expect(
      readForgePushBase({ reader: incomplete, expectedHeadSha: BASE }, new AbortController().signal)
    ).resolves.toEqual({ ok: false, reason: 'base-unavailable' })
    await expect(
      readForgePushBase({ reader: submodule, expectedHeadSha: BASE }, new AbortController().signal)
    ).resolves.toEqual({ ok: false, reason: 'base-unsupported' })
  })

  it('reports unreadable metadata as unavailable, not as a mismatch', async () => {
    const unreadable = reader({
      getRepositoryCommit: vi.fn(async () => ({ ok: false as const, code: 'network' as const }))
    })

    await expect(
      readForgePushBase({ reader: unreadable, expectedHeadSha: BASE }, new AbortController().signal)
    ).resolves.toEqual({ ok: false, reason: 'base-unavailable' })
  })

  it('reads the committer timezone from GitLab dates', () => {
    expect(parseForgeGitlabCommitDate('2023-11-14T22:13:19.000+05:30')).toEqual({
      timeSeconds: 1699980199,
      timezone: '+0530'
    })
    expect(parseForgeGitlabCommitDate('2023-11-14T22:13:19Z')).toEqual({
      timeSeconds: 1699999999,
      timezone: '+0000'
    })
    expect(parseForgeGitlabCommitDate('2023-11-14 22:13:19')).toBeNull()
    expect(parseForgeGitlabCommitDate('2023-11-14T22:13:19.000+99:99')).toBeNull()
  })
})

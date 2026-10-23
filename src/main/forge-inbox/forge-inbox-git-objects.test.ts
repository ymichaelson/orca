import { describe, expect, it } from 'vitest'
import {
  createForgeGitBlob,
  createForgeGitCommit,
  createForgeGitTree,
  forgeGitObjectOid,
  type ForgeGitIdentity
} from './forge-inbox-git-objects'

const HELLO = 'ce013625030ba8dba906f756967f9e9ca394464a'
const WORLD = 'cc628ccd10742baea8241c5924df992b5c019f71'
const TREE_A = '2e81171448eb9f2ee3821e3d447aa6b2fe3ddba1'
const IDENTITY: ForgeGitIdentity = {
  name: 'Orca',
  email: 'orca@example.com',
  timeSeconds: 1700000000,
  timezone: '+0000'
}

describe('forge git objects', () => {
  it('hashes a blob the way git does', () => {
    const blob = createForgeGitBlob('hello\n')

    expect(blob.oid).toBe(HELLO)
    expect(blob.content.toString('utf8')).toBe('hello\n')
    expect(forgeGitObjectOid('blob', Buffer.from('hello\n'))).toBe(HELLO)
  })

  it('hashes a tree the way git does', () => {
    const tree = createForgeGitTree([{ mode: '100644', name: 'a.txt', oid: HELLO }])

    expect(tree?.oid).toBe(TREE_A)
  })

  it('sorts entries bytewise with a trailing slash on subtrees', () => {
    const entries = [
      { mode: '40000' as const, name: 'a', oid: TREE_A },
      { mode: '100644' as const, name: 'a.txt', oid: HELLO }
    ]
    const forward = createForgeGitTree(entries)
    const reversed = createForgeGitTree(entries.toReversed())

    expect(forward?.oid).toBe(reversed?.oid)
    expect(forward?.oid).toBe('27f704b090dd7eb56abd66cef08166f7c35d9ce7')
  })

  it.each([
    ['an empty name', [{ mode: '100644', name: '', oid: HELLO }]],
    ['a slash', [{ mode: '100644', name: 'a/b', oid: HELLO }]],
    ['a dot entry', [{ mode: '100644', name: '.', oid: HELLO }]],
    ['a .git entry', [{ mode: '100644', name: '.GIT', oid: HELLO }]],
    ['a NUL', [{ mode: '100644', name: 'a\u0000b', oid: HELLO }]],
    [
      'a case-folded duplicate',
      [
        { mode: '100644', name: 'A.txt', oid: HELLO },
        { mode: '100644', name: 'a.txt', oid: HELLO }
      ]
    ],
    ['a short object id', [{ mode: '100644', name: 'a.txt', oid: 'abc' }]]
  ] as const)('refuses %s', (_label, entries) => {
    expect(createForgeGitTree([...entries])).toBeNull()
  })

  it('hashes a commit the way git does', () => {
    const commit = createForgeGitCommit({
      tree: TREE_A,
      parents: [],
      author: IDENTITY,
      committer: IDENTITY,
      message: 'Initial commit\n'
    })

    expect(commit?.oid).toBe('c5af78b3d8f7733036da71ca58cb855f71c0cae3')
    expect(commit?.content.toString('utf8')).toBe(
      [
        `tree ${TREE_A}`,
        'author Orca <orca@example.com> 1700000000 +0000',
        'committer Orca <orca@example.com> 1700000000 +0000',
        '',
        'Initial commit',
        ''
      ].join('\n')
    )
  })

  it('writes parents in the order given', () => {
    const first = 'a'.repeat(40)
    const second = 'b'.repeat(40)
    const commit = createForgeGitCommit({
      tree: TREE_A,
      parents: [first, second],
      author: IDENTITY,
      committer: IDENTITY,
      message: 'Merge\n'
    })

    expect(commit?.content.toString('utf8').split('\n').slice(0, 3)).toEqual([
      `tree ${TREE_A}`,
      `parent ${first}`,
      `parent ${second}`
    ])
  })

  it.each([
    ['an empty name', { ...IDENTITY, name: '' }],
    ['an angle bracket in the name', { ...IDENTITY, name: 'Or<ca' }],
    ['an email without @', { ...IDENTITY, email: 'orca' }],
    ['a negative time', { ...IDENTITY, timeSeconds: -1 }],
    ['a fractional time', { ...IDENTITY, timeSeconds: 1.5 }],
    ['a malformed timezone', { ...IDENTITY, timezone: 'UTC' }],
    ['an out-of-range timezone', { ...IDENTITY, timezone: '+1560' }]
  ] as const)('refuses %s', (_label, identity) => {
    expect(
      createForgeGitCommit({
        tree: TREE_A,
        parents: [],
        author: identity,
        committer: identity,
        message: 'x\n'
      })
    ).toBeNull()
  })

  it('refuses a binary message or a malformed tree id', () => {
    const base = {
      parents: [],
      author: IDENTITY,
      committer: IDENTITY
    }

    expect(createForgeGitCommit({ ...base, tree: 'abc', message: 'x\n' })).toBeNull()
    expect(createForgeGitCommit({ ...base, tree: TREE_A, message: 'a\u0000b' })).toBeNull()
  })

  it('produces distinct ids for distinct blobs', () => {
    expect(createForgeGitBlob('world\n').oid).toBe(WORLD)
    expect(createForgeGitBlob('hello\n').oid).not.toBe(createForgeGitBlob('hello\n ').oid)
  })
})

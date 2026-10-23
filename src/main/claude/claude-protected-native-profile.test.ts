import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  admitProtectedClaudeNativeArtifact,
  admitProtectedClaudePrivateRoot,
  inspectProtectedClaudeNativeArtifact
} from './claude-protected-native-profile'

const PINNED = [
  ['darwin-arm64', 'mach-o', '5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37'],
  ['linux-x64', 'elf', '60d7eb7f12fbb28a52533fe8be5884097403562aa02dc73991a021c7067e29a5'],
  ['win32-x64', 'pe', '3ab075f78998efef8b87f491c2e4a39c309dddf44e51d0103eba4f3713d2a0ae']
] as const

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-protected-native-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('audited native 2.1.302 artifact admission without executing a version probe', () => {
  it.each(PINNED)('admits the exact %s native fingerprint', (platform, format, sha256) => {
    const path = platform === 'win32-x64' ? 'C:\\fake\\native\\claude.exe' : '/fake/native/claude'
    expect(
      admitProtectedClaudeNativeArtifact({ path, canonicalPath: path, platform, format, sha256 })
    ).toEqual({
      path,
      platform,
      sha256
    })
  })

  it.each([
    ['unknown hash', { sha256: 'a'.repeat(64) }],
    ['unsupported platform', { platform: 'linux-arm64' }],
    ['script wrapper', { format: 'script', path: '/fake/native/claude.js' }],
    ['relative executable', { path: 'claude', canonicalPath: 'claude' }],
    ['noncanonical executable', { path: '/fake/native/link', canonicalPath: '/fake/native/claude' }]
  ])('refuses %s before any process is available', (_name, extra) => {
    expect(() =>
      admitProtectedClaudeNativeArtifact({
        path: '/fake/native/claude',
        canonicalPath: '/fake/native/claude',
        platform: 'darwin-arm64',
        format: 'mach-o',
        sha256: PINNED[0][2],
        ...extra
      })
    ).toThrow()
  })

  it('reads and refuses a test-owned unknown artifact without executing it or trusting version text', async () => {
    const path = join(root, 'claude')
    await writeFile(path, '2.1.302 (Claude Code)\nnot-the-audited-native-artifact\n', {
      mode: 0o700
    })
    await expect(inspectProtectedClaudeNativeArtifact(path, 'darwin-arm64')).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toContain('not-the-audited-native-artifact')
  })
})

describe('private analysis namespace admission uses filesystem metadata, not git subprocesses', () => {
  it('admits a canonical owned namespace outside ordinary history roots', async () => {
    const privateRoot = join(root, 'state', 'forge-protected-analysis', 'session-alpha')
    const scanRoot = join(root, 'ordinary', '.claude')
    await mkdir(privateRoot, { recursive: true })
    await mkdir(scanRoot, { recursive: true })
    expect(await admitProtectedClaudePrivateRoot({ privateRoot, scanRoots: [scanRoot] })).toBe(
      privateRoot
    )
  })

  it.each(['directory', 'file'] as const)(
    'refuses a .git %s ancestor without invoking git',
    async (kind) => {
      const ancestor = join(root, 'repo')
      await mkdir(ancestor)
      await (kind === 'directory'
        ? mkdir(join(ancestor, '.git'))
        : writeFile(join(ancestor, '.git'), 'gitdir: /fake/worktrees/one\n'))
      const privateRoot = join(ancestor, 'state', 'forge-protected-analysis', 'session-alpha')
      await expect(
        admitProtectedClaudePrivateRoot({ privateRoot, scanRoots: [] })
      ).rejects.toThrow()
      expect(await readFile(join(ancestor, '.git'), 'utf8').catch(() => kind)).toBe(
        kind === 'file' ? 'gitdir: /fake/worktrees/one\n' : kind
      )
    }
  )

  it.each(['inside', 'ancestor'] as const)(
    'refuses a private root %s an ordinary provider scan root',
    async (overlap) => {
      const scanRoot = join(root, 'ordinary', '.claude')
      await mkdir(scanRoot, { recursive: true })
      const privateRoot = overlap === 'inside' ? join(scanRoot, 'analysis') : root
      await expect(
        admitProtectedClaudePrivateRoot({ privateRoot, scanRoots: [scanRoot] })
      ).rejects.toThrow()
    }
  )

  it('refuses a symlink spelling of an ordinary history namespace and does not modify user configuration', async () => {
    const userConfig = join(root, 'user-config')
    await mkdir(userConfig)
    const canary = join(userConfig, 'settings.json')
    await writeFile(canary, '{"fake":"user-owned-canary"}')
    const alias = join(root, 'private-alias')
    await symlink(userConfig, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(
      admitProtectedClaudePrivateRoot({ privateRoot: alias, scanRoots: [userConfig] })
    ).rejects.toThrow()
    expect(await readFile(canary, 'utf8')).toBe('{"fake":"user-owned-canary"}')
  })
})

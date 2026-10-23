import { describe, expect, it } from 'vitest'
import { protectedClaudeScanRoots } from './claude-protected-scan-roots'

const options =
  (overrides: Record<string, unknown> = {}) =>
  async () => ({
    claudeProjectsDir: '/scan/claude',
    claudeProfileProjectsDirs: ['/scan/profile'],
    opencodeStorageDir: '/scan/shared',
    antigravityBrainDir: '/scan/shared',
    wslHomeDirs: ['/wsl/one'],
    ...overrides
  })

describe('protectedClaudeScanRoots', () => {
  it('names the claude, opencode and antigravity trees plus each WSL home', async () => {
    const roots = await protectedClaudeScanRoots(options())

    expect(roots).toContain('/scan/claude')
    expect(roots).toContain('/scan/profile')
    // The same tree reached through two different sources appears once.
    expect(roots.filter((root) => root === '/scan/shared')).toHaveLength(1)
    expect(roots).toContain('/wsl/one/.claude/projects')
    expect(roots).toContain('/wsl/one/.local/share/opencode/storage')
  })

  it('drops blank and repeated WSL homes', async () => {
    const roots = await protectedClaudeScanRoots(
      options({ wslHomeDirs: ['/wsl/one', '  ', '/wsl/one'] })
    )

    expect(roots.filter((root) => root === '/wsl/one/.claude/projects')).toHaveLength(1)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { getDefaultTabsLaunch, getEffectiveHooksFromConfig } from './effective-hook-config'
import {
  makeHookTestRepo,
  TEST_REPO_ORCA_YAML_PATH,
  TEST_WORKTREE_ORCA_YAML_PATH,
  TEST_WORKTREE_PATH
} from './hooks-test-fixtures'

// Mock fs used by loadHooks
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  chmodSync: vi.fn()
}))

describe('getEffectiveHooks', () => {
  // We need to dynamically import after mocking
  const makeRepo = (hookSettings?: {
    mode?: 'auto' | 'override'
    setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default'
    commandSourcePolicy?: 'shared-only' | 'local-only' | 'run-both'
    scripts?: { setup: string; archive: string }
  }) => makeHookTestRepo(hookSettings)

  it('uses hooks from orca.yaml when present', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo "yaml setup"\n')

    // Re-import to pick up mocks
    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo()
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "yaml setup"'
      }
    })
  })

  it("loads setup hooks from the target worktree's orca.yaml when a worktree path is provided", async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === TEST_REPO_ORCA_YAML_PATH || path === TEST_WORKTREE_ORCA_YAML_PATH
    )
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === TEST_REPO_ORCA_YAML_PATH) {
        return 'scripts:\n  setup: |\n    echo old-version\n'
      }
      if (path === TEST_WORKTREE_ORCA_YAML_PATH) {
        return 'scripts:\n  setup: |\n    echo new-version\n'
      }
      return ''
    })

    const { getEffectiveHooks } = await import('./hooks')
    const result = getEffectiveHooks(makeRepo(), TEST_WORKTREE_PATH)

    expect(result).toEqual({
      scripts: {
        setup: 'echo new-version'
      }
    })
    expect(result?.scripts.setup).not.toContain('old-version')
  })

  it('falls back to legacy local hooks when policy is unset and yaml is missing', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "local setup"', archive: 'echo "local archive"' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "local setup"',
        archive: 'echo "local archive"'
      }
    })
  })

  it('does not fall back to local hooks when policy is explicitly shared-only', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      commandSourcePolicy: 'shared-only',
      scripts: { setup: 'echo "local setup"', archive: 'echo "local archive"' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toBeNull()
  })

  it('uses local settings over shared yaml settings by default when local hooks exist', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo "yaml setup"\n')

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "ui override"', archive: '' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "ui override"'
      }
    })
  })

  it('uses only local settings when command source policy is local-only', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo "yaml setup"\n')

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      commandSourcePolicy: 'local-only',
      scripts: { setup: 'echo "local setup"', archive: '' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "local setup"'
      }
    })
  })

  it('runs yaml before local settings when command source policy is run-both', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo "yaml setup"\n')

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      commandSourcePolicy: 'run-both',
      scripts: { setup: 'echo "local setup"', archive: '' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "yaml setup"\necho "local setup"'
      }
    })
  })

  it('uses local settings by default even when orca.yaml defines only one command', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  archive: |\n    echo "yaml archive"\n')

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "legacy setup"', archive: 'echo "legacy archive"' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "legacy setup"',
        archive: 'echo "legacy archive"'
      }
    })
  })

  it('keeps shared setup when only archive has a legacy local script', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      'scripts:\n  setup: |\n    echo "yaml setup"\n  archive: |\n    echo "yaml archive"\n'
    )

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: '', archive: 'echo "legacy archive"' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "yaml setup"',
        archive: 'echo "legacy archive"'
      }
    })
  })

  it('uses local settings by default when yaml exists without supported hooks', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('futureFeature: enabled\n')

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "legacy setup"', archive: 'echo "legacy archive"' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "legacy setup"',
        archive: 'echo "legacy archive"'
      }
    })
  })

  it('treats legacy shared-first policy as orca.yaml only', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  archive: |\n    echo "yaml archive"\n')

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      commandSourcePolicy: 'shared-first' as never,
      scripts: { setup: 'echo "legacy setup"', archive: 'echo "legacy archive"' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        archive: 'echo "yaml archive"'
      }
    })
  })

  it('returns null when no hooks at all', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({ mode: 'auto', scripts: { setup: '', archive: '' } })
    const result = getEffectiveHooks(repo)

    expect(result).toBeNull()
  })

  it('falls back to legacy local setup source only when yaml is missing', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getSetupCommandSource } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "legacy setup"', archive: '' }
    })
    const result = getSetupCommandSource(repo)

    expect(result).toEqual({ source: 'local', command: 'echo "legacy setup"' })
  })

  it('uses local setup source by default when yaml omits setup', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  archive: |\n    echo "yaml archive"\n')

    const { getSetupCommandSource } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "legacy setup"', archive: '' }
    })
    const result = getSetupCommandSource(repo)

    expect(result).toEqual({ source: 'local', command: 'echo "legacy setup"' })
  })

  it('uses local setup source by default when yaml exists without supported hooks', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('futureFeature: enabled\n')

    const { getSetupCommandSource } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "legacy setup"', archive: '' }
    })
    const result = getSetupCommandSource(repo)

    expect(result).toEqual({ source: 'local', command: 'echo "legacy setup"' })
  })

  it('uses shared setup source when only archive has a legacy local script', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      'scripts:\n  setup: |\n    echo "yaml setup"\n  archive: |\n    echo "yaml archive"\n'
    )

    const { getSetupCommandSource } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: '', archive: 'echo "legacy archive"' }
    })
    const result = getSetupCommandSource(repo)

    expect(result).toEqual({ source: 'yaml', command: 'echo "yaml setup"' })
  })
})

describe('shouldRunSetupForCreate', () => {
  const makeRepo = (setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default') =>
    makeHookTestRepo({
      mode: 'auto',
      setupRunPolicy,
      scripts: { setup: '', archive: '' }
    })

  it('requires an explicit decision when the repo policy is ask', async () => {
    const { shouldRunSetupForCreate } = await import('./effective-hook-config')

    expect(() => shouldRunSetupForCreate(makeRepo('ask'))).toThrow(
      'Setup decision required for this repository'
    )
  })

  it('uses the repo default when the caller inherits', async () => {
    const { shouldRunSetupForCreate } = await import('./effective-hook-config')

    expect(shouldRunSetupForCreate(makeRepo('run-by-default'))).toBe(true)
    expect(shouldRunSetupForCreate(makeRepo('skip-by-default'))).toBe(false)
  })

  it('lets the caller override the repo default per create', async () => {
    const { shouldRunSetupForCreate } = await import('./effective-hook-config')

    expect(shouldRunSetupForCreate(makeRepo('skip-by-default'), 'run')).toBe(true)
    expect(shouldRunSetupForCreate(makeRepo('run-by-default'), 'skip')).toBe(false)
  })
})

describe('getDefaultTabsLaunch', () => {
  const makeRepo = (
    setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default',
    commandSourcePolicy?: 'local-only' | 'run-both' | 'shared-only'
  ) =>
    makeHookTestRepo({
      mode: 'auto',
      setupRunPolicy,
      commandSourcePolicy,
      scripts: { setup: '', archive: '' }
    })

  it('opts into default tab command execution through the setup decision', () => {
    const hooks = {
      scripts: {},
      defaultTabs: [{ title: 'Server', command: 'pnpm dev' }]
    }

    expect(getDefaultTabsLaunch(hooks, makeRepo('skip-by-default'), 'run')).toEqual({
      tabs: hooks.defaultTabs,
      runCommands: true
    })
    expect(getDefaultTabsLaunch(hooks, makeRepo('run-by-default'), 'skip')).toEqual({
      tabs: hooks.defaultTabs,
      runCommands: false
    })
  })

  it('creates commandless default tabs without requiring setup approval', () => {
    const hooks = {
      scripts: {},
      defaultTabs: [{ title: 'Notes' }]
    }

    expect(getDefaultTabsLaunch(hooks, makeRepo('ask'))).toEqual({
      tabs: hooks.defaultTabs,
      runCommands: false
    })
  })

  it('does not run shared default tab commands when command source is local-only', () => {
    const hooks = {
      scripts: {},
      defaultTabs: [{ title: 'Server', command: 'pnpm dev' }]
    }

    expect(getDefaultTabsLaunch(hooks, makeRepo('run-by-default', 'local-only'))).toEqual({
      tabs: hooks.defaultTabs,
      runCommands: false
    })
  })
})

describe('getEffectiveHooksFromConfig with global defaults', () => {
  const makeRepo = (hookSettings?: {
    mode?: 'auto' | 'override'
    commandSourcePolicy?: 'shared-only' | 'local-only' | 'run-both'
    scripts?: { setup: string; archive: string }
  }) => makeHookTestRepo(hookSettings)
  const GLOBAL = { setup: 'echo "global setup"', archive: 'echo "global archive"' }
  const yaml = (scripts: { setup?: string; archive?: string }) => ({ scripts })

  it('uses the global default when no local or shared script exists', () => {
    expect(getEffectiveHooksFromConfig(makeRepo(), yaml({}), GLOBAL)).toEqual({
      scripts: { setup: 'echo "global setup"', archive: 'echo "global archive"' }
    })
  })

  it('treats a whitespace-only global default as empty', () => {
    expect(
      getEffectiveHooksFromConfig(makeRepo(), yaml({}), { setup: '  ', archive: '' })
    ).toBeNull()
  })

  it('returns null when global defaults are omitted and no script exists', () => {
    expect(getEffectiveHooksFromConfig(makeRepo(), yaml({}))).toBeNull()
  })

  it('prefers the shared script over the global default', () => {
    expect(
      getEffectiveHooksFromConfig(makeRepo(), yaml({ setup: 'echo "shared setup"' }), GLOBAL)
    ).toEqual({ scripts: { setup: 'echo "shared setup"', archive: 'echo "global archive"' } })
  })

  it('prefers the local script over the global default', () => {
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "local setup"', archive: '' }
    })
    expect(getEffectiveHooksFromConfig(repo, yaml({}), GLOBAL)).toEqual({
      scripts: { setup: 'echo "local setup"', archive: 'echo "global archive"' }
    })
  })

  it('concatenates shared and local under run-both and ignores the global default', () => {
    const repo = makeRepo({
      mode: 'override',
      commandSourcePolicy: 'run-both',
      scripts: { setup: 'echo "local setup"', archive: '' }
    })
    expect(
      getEffectiveHooksFromConfig(repo, yaml({ setup: 'echo "shared setup"' }), GLOBAL)
    ).toEqual({
      scripts: {
        setup: 'echo "shared setup"\necho "local setup"',
        archive: 'echo "global archive"'
      }
    })
  })

  it('does not fall back when a policy-ignored local script exists under shared-only', () => {
    const repo = makeRepo({
      mode: 'override',
      commandSourcePolicy: 'shared-only',
      scripts: { setup: 'echo "local setup"', archive: '' }
    })
    expect(getEffectiveHooksFromConfig(repo, yaml({}), GLOBAL)).toEqual({
      scripts: { archive: 'echo "global archive"' }
    })
  })

  it('does not fall back when a policy-ignored shared script exists under local-only', () => {
    const repo = makeRepo({
      mode: 'override',
      commandSourcePolicy: 'local-only',
      scripts: { setup: '', archive: '' }
    })
    expect(
      getEffectiveHooksFromConfig(repo, yaml({ setup: 'echo "shared setup"' }), GLOBAL)
    ).toEqual({ scripts: { archive: 'echo "global archive"' } })
  })

  it('resolves setup and archive independently', () => {
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: '', archive: 'echo "local archive"' }
    })
    expect(
      getEffectiveHooksFromConfig(repo, yaml({ setup: 'echo "shared setup"' }), GLOBAL)
    ).toEqual({
      scripts: { setup: 'echo "shared setup"', archive: 'echo "local archive"' }
    })
  })
})

describe('getEffectiveHooks with global defaults', () => {
  const makeRepo = (hookSettings?: {
    mode?: 'auto' | 'override'
    commandSourcePolicy?: 'shared-only' | 'local-only' | 'run-both'
    scripts?: { setup: string; archive: string }
  }) => makeHookTestRepo(hookSettings)
  const GLOBAL = { setup: 'echo "global setup"', archive: 'echo "global archive"' }

  it('passes global defaults through to the fallback', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getEffectiveHooks } = await import('./hooks')
    expect(getEffectiveHooks(makeRepo(), undefined, GLOBAL)).toEqual({
      scripts: { setup: 'echo "global setup"', archive: 'echo "global archive"' }
    })
  })

  it('reports the global source when the fallback applies', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getSetupCommandSource } = await import('./hooks')
    expect(getSetupCommandSource(makeRepo(), undefined, GLOBAL)).toEqual({
      source: 'global',
      command: 'echo "global setup"'
    })
  })

  it('does not report the global source when a policy-ignored script blocks it', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getSetupCommandSource } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      commandSourcePolicy: 'shared-only',
      scripts: { setup: 'echo "local setup"', archive: '' }
    })
    expect(getSetupCommandSource(repo, undefined, GLOBAL)).toBeNull()
  })
})

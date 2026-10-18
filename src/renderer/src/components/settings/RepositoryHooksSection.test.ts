// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import type { Repo } from '../../../../shared/repo-types'
import { readRuntimeIssueCommand } from '@/runtime/runtime-hooks-client'
import { getLocalCommandSourcePolicyNotice, RepositoryHooksSection } from './RepositoryHooksSection'

let mockSettings: Record<string, unknown> = {}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: mockSettings,
      settingsSearchQuery: ''
    })
}))

vi.mock('@/runtime/runtime-hooks-client', () => ({
  readRuntimeIssueCommand: vi.fn().mockResolvedValue({ command: '', exists: false }),
  writeRuntimeIssueCommand: vi.fn().mockResolvedValue(undefined)
}))

const repo: Repo = {
  id: 'repo-1',
  kind: 'git',
  path: '/workspace/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 1,
  gitUsername: ''
}

function renderRepositoryHooksSection(args: {
  onUpdateHookSettings: (settings: NonNullable<Repo['hookSettings']>) => void
  repo?: Repo
  yamlHooks?: OrcaHooks | null
}): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      React.createElement(RepositoryHooksSection, {
        repo: args.repo ?? repo,
        yamlHooks: args.yamlHooks ?? null,
        hasHooksFile: false,
        hooksInspectionReady: true,
        mayNeedUpdate: false,
        copiedTemplate: false,
        forceVisible: true,
        onCopyTemplate: () => {},
        onUpdateHookSettings: args.onUpdateHookSettings
      })
    )
  })
  return { container, root }
}

let rendered: { container: HTMLDivElement; root: Root } | null = null

afterEach(() => {
  act(() => rendered?.root.unmount())
  rendered?.container.remove()
  rendered = null
  mockSettings = {}
})

describe('getLocalCommandSourcePolicyNotice', () => {
  it('does not show a notice when no local scripts are saved', () => {
    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: true,
        currentPolicy: 'shared-only',
        setupScript: '',
        archiveScript: '',
        hasSharedScript: false
      })
    ).toBeNull()
  })

  it('does not show a notice when command source already includes local scripts', () => {
    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: true,
        currentPolicy: 'local-only',
        setupScript: 'pnpm install',
        archiveScript: '',
        hasSharedScript: true
      })
    ).toBeNull()

    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: true,
        currentPolicy: 'run-both',
        setupScript: '',
        archiveScript: 'echo archive',
        hasSharedScript: true
      })
    ).toBeNull()
  })

  it('waits for hook inspection before recommending a command source', () => {
    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: false,
        currentPolicy: 'shared-only',
        setupScript: 'pnpm install',
        archiveScript: '',
        hasSharedScript: false
      })
    ).toEqual({ kind: 'checking' })
  })

  it('recommends local commands when local scripts are saved and no shared script exists', () => {
    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: true,
        currentPolicy: 'shared-only',
        setupScript: 'pnpm install',
        archiveScript: '',
        hasSharedScript: false
      })
    ).toEqual({ kind: 'action', policy: 'local-only', label: 'Use local commands' })
  })

  it('recommends run-both when local and shared scripts both exist', () => {
    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: true,
        currentPolicy: 'shared-only',
        setupScript: '',
        archiveScript: 'echo archive',
        hasSharedScript: true
      })
    ).toEqual({ kind: 'action', policy: 'run-both', label: 'Run both' })
  })
})

describe('RepositoryHooksSection setup startup policy', () => {
  it('persists wait-for-setup when the repository toggle is checked', () => {
    const updates: NonNullable<Repo['hookSettings']>[] = []
    rendered = renderRepositoryHooksSection({
      onUpdateHookSettings: (settings) => updates.push(settings)
    })

    const waitSwitch = rendered.container.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Wait for setup to complete before starting agent"]'
    )
    expect(waitSwitch).toBeTruthy()

    act(() => waitSwitch?.click())

    expect(updates.at(-1)).toMatchObject({
      setupAgentStartupPolicy: 'wait-for-setup',
      setupRunPolicy: 'run-by-default',
      scripts: { setup: '', archive: '' }
    })
  })
})

describe('RepositoryHooksSection execution ownership', () => {
  it('routes issue-command reads through the repository runtime owner', async () => {
    vi.mocked(readRuntimeIssueCommand).mockClear()
    await act(async () => {
      rendered = renderRepositoryHooksSection({
        onUpdateHookSettings: () => {},
        repo: { ...repo, executionHostId: 'runtime:hub' }
      })
      await Promise.resolve()
    })

    expect(readRuntimeIssueCommand).toHaveBeenCalledWith('runtime:hub', repo.id)
  })
})

describe('RepositoryHooksSection global default hint', () => {
  it('shows the inherited global setup script when the project has no script', () => {
    mockSettings = {
      globalHookDefaults: { setup: 'global setup', archive: '' }
    }
    rendered = renderRepositoryHooksSection({ onUpdateHookSettings: () => {} })

    expect(rendered.container.textContent).toContain('Global default')
    expect(rendered.container.textContent).toContain('global setup')
  })

  it('hides the hint when a local script is set', () => {
    mockSettings = {
      globalHookDefaults: { setup: 'global setup', archive: '' }
    }
    rendered = renderRepositoryHooksSection({
      onUpdateHookSettings: () => {},
      repo: {
        ...repo,
        hookSettings: { mode: 'auto', scripts: { setup: 'local setup', archive: '' } }
      }
    })

    expect(rendered.container.textContent).not.toContain('Global default')
  })

  it('hides the hint when a shared script is set', () => {
    mockSettings = {
      globalHookDefaults: { setup: 'global setup', archive: '' }
    }
    rendered = renderRepositoryHooksSection({
      onUpdateHookSettings: () => {},
      yamlHooks: { scripts: { setup: 'shared setup' } }
    })

    expect(rendered.container.textContent).not.toContain('Global default')
  })

  it('hides the hint when no global default is set', () => {
    rendered = renderRepositoryHooksSection({ onUpdateHookSettings: () => {} })

    expect(rendered.container.textContent).not.toContain('Global default')
  })
})

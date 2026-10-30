import { vi, type Mock } from 'vitest'

const {
  applyAppIconMock,
  applyAgentStatusHooksEnabledMock,
  applyElectronProxySettingsMock,
  browserWindowGetAllWindowsMock,
  handleMock,
  onMock,
  previewGhosttyImportMock,
  previewWarpThemeImportMock,
  prepareLocalWorktreeRootsForReposMock,
  resolveEnvironmentMock,
  listEnvironmentsMock,
  rebuildAppMenuMock,
  applyBrowserSessionProxiesMock,
  applySessionSearchSettingsChangeMock,
  listProfilesMock
}: Record<
  | 'applyAppIconMock'
  | 'applyAgentStatusHooksEnabledMock'
  | 'applyElectronProxySettingsMock'
  | 'browserWindowGetAllWindowsMock'
  | 'handleMock'
  | 'onMock'
  | 'previewGhosttyImportMock'
  | 'previewWarpThemeImportMock'
  | 'prepareLocalWorktreeRootsForReposMock'
  | 'resolveEnvironmentMock'
  | 'listEnvironmentsMock'
  | 'rebuildAppMenuMock'
  | 'applyBrowserSessionProxiesMock'
  | 'applySessionSearchSettingsChangeMock'
  | 'listProfilesMock',
  Mock
> = vi.hoisted(() => ({
  applyAppIconMock: vi.fn(),
  applyAgentStatusHooksEnabledMock: vi.fn(),
  applyElectronProxySettingsMock: vi.fn(),
  browserWindowGetAllWindowsMock: vi.fn(),
  handleMock: vi.fn(),
  onMock: vi.fn(),
  previewGhosttyImportMock: vi.fn(),
  previewWarpThemeImportMock: vi.fn(),
  prepareLocalWorktreeRootsForReposMock: vi.fn(),
  resolveEnvironmentMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  rebuildAppMenuMock: vi.fn(),
  applyBrowserSessionProxiesMock: vi.fn(),
  applySessionSearchSettingsChangeMock: vi.fn(),
  listProfilesMock: vi.fn(() => [])
}))

export {
  applyAppIconMock,
  applyAgentStatusHooksEnabledMock,
  applyElectronProxySettingsMock,
  browserWindowGetAllWindowsMock,
  handleMock,
  onMock,
  previewGhosttyImportMock,
  previewWarpThemeImportMock,
  prepareLocalWorktreeRootsForReposMock,
  resolveEnvironmentMock,
  listEnvironmentsMock,
  rebuildAppMenuMock,
  applyBrowserSessionProxiesMock,
  applySessionSearchSettingsChangeMock,
  listProfilesMock
}

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/test/user-data') },
  BrowserWindow: { getAllWindows: browserWindowGetAllWindowsMock },
  ipcMain: { handle: handleMock, on: onMock },
  nativeTheme: { themeSource: 'system' }
}))

vi.mock('../ghostty/index', () => ({
  previewGhosttyImport: previewGhosttyImportMock
}))

vi.mock('../warp-themes', () => ({
  previewWarpThemeImport: previewWarpThemeImportMock
}))

vi.mock('../network/proxy-settings', () => ({
  applyElectronProxySettings: applyElectronProxySettingsMock
}))

vi.mock('../browser/browser-session-proxy', () => ({
  applyBrowserSessionProxies: applyBrowserSessionProxiesMock
}))

vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: { listProfiles: listProfilesMock }
}))

vi.mock('../app-icon', () => ({
  applyAppIcon: applyAppIconMock
}))

vi.mock('../ai-vault-search/session-search-enablement', () => ({
  applySessionSearchSettingsChange: applySessionSearchSettingsChangeMock
}))

vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock
}))

vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootsForRepos: prepareLocalWorktreeRootsForReposMock
}))

vi.mock('../menu/register-app-menu', () => ({
  rebuildAppMenu: rebuildAppMenuMock
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: resolveEnvironmentMock,
  listEnvironments: listEnvironmentsMock
}))

export const settingsInvokeEvent = { sender: { id: 1 } }
export type SettingsChangedListener = (
  updates: unknown,
  settings: unknown,
  originWebContentsId?: number
) => void

export const store: {
  getSettings: Mock
  updateSettings: Mock
  updateSettingsAndFlush: Mock
  getGitHubCache: Mock
  setGitHubCache: Mock
  onSettingsChanged: Mock
} = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  updateSettingsAndFlush: vi.fn(),
  getGitHubCache: vi.fn(),
  setGitHubCache: vi.fn(),
  onSettingsChanged: vi.fn(() => () => {})
}

export function resetSettingsIpcTestFixture(): void {
  handleMock.mockClear()
  store.updateSettingsAndFlush.mockReset()
  onMock.mockClear()
  applyAppIconMock.mockClear()
  applyAgentStatusHooksEnabledMock.mockReset().mockResolvedValue([])
  applyElectronProxySettingsMock.mockClear()
  applyElectronProxySettingsMock.mockResolvedValue({ source: 'settings' })
  previewGhosttyImportMock.mockClear()
  previewWarpThemeImportMock.mockClear()
  prepareLocalWorktreeRootsForReposMock.mockReset().mockResolvedValue(undefined)
  resolveEnvironmentMock.mockReset().mockImplementation((_userDataPath, selector) => {
    if (selector !== 'windows-2' && selector !== 'Windows 2') {
      throw new Error('Runtime environment not found')
    }
    return { id: 'windows-2' }
  })
  rebuildAppMenuMock.mockClear()
  applyBrowserSessionProxiesMock.mockReset().mockResolvedValue(undefined)
  applySessionSearchSettingsChangeMock.mockClear()
  listProfilesMock.mockReset().mockReturnValue([])
  browserWindowGetAllWindowsMock.mockReset()
  store.getSettings.mockReset()
  store.updateSettings.mockReset()
  store.onSettingsChanged.mockClear()
  listEnvironmentsMock.mockReset().mockReturnValue([])
}

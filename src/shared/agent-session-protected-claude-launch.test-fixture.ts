export const PROTECTED_ANALYSIS_MARKER = {
  ownerId: '0b8f2c1e-5a3d-4f6b-9c7e-1d2a3b4c5d6e',
  instanceId: 'instance-1',
  itemId: '101',
  analysisKind: 'merge_request'
} as const

export function protectedClaudeLaunchFixture(
  privateRoot = '/fake/orca/forge-protected-analysis/session-alpha-1'
) {
  return {
    version: 1,
    profile: 'claude-native-data-only-2.1.302-v1',
    executable: {
      path: '/fake/native/claude',
      platform: 'darwin-arm64',
      sha256: '5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37'
    },
    privateRoot,
    auth: {
      kind: 'saved-agent-env',
      settingsKey: 'claude',
      credentialKey: 'ANTHROPIC_API_KEY',
      baseUrl: 'https://api.anthropic.com'
    }
  } as const
}

import { completeAntigravityTranscriptPairs } from './antigravity-transcript-candidates'
import { ANTIGRAVITY_HISTORY_ROOTS } from '../../shared/antigravity-session-origin'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  isAntigravityTranscriptPath,
  shouldDescendAntigravityBrainDirectory
} from './session-scanner-antigravity-paths'
import { discoverFiles } from './session-scanner-discovery'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'
import { scopeWalksAgentFiles } from './session-scope-cwd'

export function antigravityDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return antigravityBrainRootDirs(options, wslHomeDirs).map((rootDir) =>
    discoverFiles({
      rootDir,
      limit,
      agent: 'antigravity',
      issues,
      extensions: ['.jsonl'],
      filePredicate: isAntigravityTranscriptPath,
      directoryPredicate: shouldDescendAntigravityBrainDirectory,
      keepScopeFiles: scopeWalksAgentFiles('antigravity', options.scopePaths),
      signal: options.signal
    }).then((discovery) => completeAntigravityTranscriptPairs(discovery, issues))
  )
}

/** Split out of the scan so a caller can name the trees without listing them. */
export function antigravityBrainRootDirs(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[]
): string[] {
  const origins =
    options.includeAntigravityIdeSessions === true
      ? ANTIGRAVITY_HISTORY_ROOTS
      : (['antigravity-cli'] as const)
  const home = options.antigravityAppHome ?? homedir()
  return [
    options.antigravityBrainDir ?? join(home, '.gemini', 'antigravity-cli', 'brain'),
    ...(options.includeAntigravityIdeSessions === true &&
    (!options.antigravityBrainDir || options.antigravityAppHome)
      ? origins
          .filter((origin) => origin !== 'antigravity-cli')
          .map((origin) => join(home, '.gemini', origin, 'brain'))
      : []),
    ...wslHomeDirs.flatMap((homeDir) =>
      origins.map((origin) => join(homeDir, '.gemini', origin, 'brain'))
    )
  ]
}

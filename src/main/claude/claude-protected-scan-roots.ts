import type { AiVaultScanOptions } from '../ai-vault/session-scanner-types'
import { AI_VAULT_AGENT_SOURCES } from '../ai-vault/session-scanner-agent-sources'
import { antigravityBrainRootDirs } from '../ai-vault/session-scanner-antigravity-sources'
import { opencodeStorageDirs } from '../ai-vault/session-scanner-opencode-sources'
import { normalizedWslHomeDirs, uniqueDirs } from '../ai-vault/session-scanner-roots'
import { localAiVaultScanRoots } from '../ai-vault/cached-session-list'

/**
 * Every tree the AI vault lists transcripts from, so a protected home can be checked
 * against all of them — a private root nested in any of these would still be discoverable.
 */
export async function protectedClaudeScanRoots(
  resolveOptions: () => Promise<AiVaultScanOptions> = localAiVaultScanRoots
): Promise<string[]> {
  const options = await resolveOptions()
  const wslHomeDirs = normalizedWslHomeDirs(options.wslHomeDirs)
  const roots: string[] = []
  for (const source of Object.values(AI_VAULT_AGENT_SOURCES)) {
    if (source) {
      roots.push(...source.rootDirs(options, wslHomeDirs))
    }
  }
  roots.push(...opencodeStorageDirs(options, wslHomeDirs))
  roots.push(...antigravityBrainRootDirs(options, wslHomeDirs))
  return uniqueDirs(roots)
}

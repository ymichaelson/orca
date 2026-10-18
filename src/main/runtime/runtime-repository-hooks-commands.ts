import { getStoredRepoSshConnectionId } from '../repo-execution-host'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Repo } from '../../shared/repo-types'
import type { GlobalHookDefaults, OrcaHooks } from '../../shared/orca-yaml-hook-types'
import { getEffectiveHooks, hasHooksFile, hasUnrecognizedOrcaYamlKeys, loadHooks } from '../hooks'
import {
  getDefaultTabCommandTrustContent,
  getEffectiveSetupRunPolicy
} from '../effective-hook-config'
import { isENOENT } from '../ipc/filesystem-auth'
import { isFolderRepo } from '../../shared/repo-kind'
import { inspectSetupScriptImportCandidates } from '../../shared/setup-script-imports'
import { joinWorktreeRelativePath } from './runtime-relative-paths'

type RuntimeRepositoryHooksCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getGlobalHookDefaults?: () => GlobalHookDefaults | undefined
}

export class RuntimeRepositoryHooksCommands {
  constructor(private readonly deps: RuntimeRepositoryHooksCommandsDeps) {}

  async getRepoHooks(repoSelector: string) {
    const repo = await this.deps.resolveRepo(repoSelector)
    const connectionId = getStoredRepoSshConnectionId(repo)
    // Why: an `ssh:` repo is not served here; it reports no hooks file.
    if (connectionId) {
      return {
        hasHooksFile: false,
        hooks: null,
        setupRunPolicy: getEffectiveSetupRunPolicy(repo),
        source: null
      }
    }
    const hasFile = hasHooksFile(repo.path)
    const globalDefaults = this.deps.getGlobalHookDefaults?.()
    const hooks = getEffectiveHooks(repo, undefined, globalDefaults)
    const sharedHooks = hasFile ? loadHooks(repo.path) : null
    return {
      hasHooksFile: hasFile,
      hooks,
      setupRunPolicy: getEffectiveSetupRunPolicy(repo),
      source: hasFile ? ('orca.yaml' as const) : hooks ? ('legacy' as const) : null,
      // Why: a client approving trust for a runtime-owned repo must see the
      // owning host's defaults, not its own.
      globalHookDefaults: globalDefaults,
      setupTrust: setupTrust(
        repo,
        getDefaultTabCommandTrustContent(sharedHooks),
        globalDefaults,
        sharedHooks
      )
    }
  }

  async checkRepoHooks(repoSelector: string) {
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      return { status: 'ok' as const, hasHooks: false, hooks: null, mayNeedUpdate: false }
    }
    const connectionId = getStoredRepoSshConnectionId(repo)
    if (connectionId) {
      return { status: 'error' as const, hasHooks: false, hooks: null, mayNeedUpdate: false }
    }
    const has = hasHooksFile(repo.path)
    const hooks = has ? loadHooks(repo.path) : null
    return {
      status: 'ok' as const,
      hasHooks: has,
      hooks,
      mayNeedUpdate: has && !hooks && hasUnrecognizedOrcaYamlKeys(repo.path)
    }
  }

  async inspectRepoSetupScriptImports(repoSelector: string) {
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      return []
    }
    return inspectSetupScriptImportCandidates(async (relativePath) => {
      const filePath = joinWorktreeRelativePath(repo.path, relativePath)
      if (getStoredRepoSshConnectionId(repo)) {
        return null
      }
      try {
        return await readFile(filePath, 'utf-8')
      } catch (error) {
        if (!isENOENT(error)) {
          console.warn('[runtime] Failed to inspect setup script import candidate:', error)
        }
        return null
      }
    })
  }
}

function setupTrust(
  repo: Repo,
  sharedTrustContent: string | undefined,
  globalDefaults: GlobalHookDefaults | undefined,
  sharedHooks: OrcaHooks | null
): { contentHash: string; scriptContent: string } | undefined {
  const localSetup = repo.hookSettings?.scripts.setup?.trim()
  const sharedSetup = sharedHooks?.scripts.setup?.trim()
  const globalSetup = globalDefaults?.setup?.trim()
  // Why: the fallback runs only when the project defines no local or shared setup script.
  const fallbackApplies = !localSetup && !sharedSetup && Boolean(globalSetup)
  const isLocalOnly = repo.hookSettings?.commandSourcePolicy === 'local-only'
  if (isLocalOnly && !fallbackApplies) {
    return undefined
  }
  // Under local-only, defaultTabs never run, so the fallback trust content is the global script alone.
  const scriptContent = fallbackApplies
    ? isLocalOnly
      ? globalSetup
      : getDefaultTabCommandTrustContent({
          scripts: { setup: globalSetup },
          defaultTabs: sharedHooks?.defaultTabs
        }).trim()
    : sharedTrustContent?.trim()
  if (!scriptContent) {
    return undefined
  }
  return { contentHash: createHash('sha256').update(scriptContent).digest('hex'), scriptContent }
}

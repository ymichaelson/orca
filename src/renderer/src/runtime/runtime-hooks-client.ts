import type {
  GlobalHookDefaults,
  OrcaHooks,
  SetupRunPolicy
} from '../../../shared/orca-yaml-hook-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { SetupScriptImportCandidate } from '../../../shared/setup-script-imports'
import { callRuntimeRpc } from './runtime-rpc-client'
import { ipcOrRuntimeTargetForHostId } from './runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

/** The repo's own host: a server's runtime, or this app (with `hostId`) for local and SSH repos. */
function getHookInspectionTarget(hostId: ExecutionHostId): RuntimeClientTarget {
  const target = ipcOrRuntimeTargetForHostId(hostId)
  if (!target) {
    throw new Error('The project host is unresolved.')
  }
  return target
}

export type HookCheckResult = {
  status?: 'ok' | 'error'
  hasHooks: boolean
  hooks: OrcaHooks | null
  mayNeedUpdate: boolean
}

export type IssueCommandReadResult = {
  status?: 'ok' | 'error'
  localContent: string | null
  sharedContent: string | null
  effectiveContent: string | null
  localFilePath: string
  source: 'local' | 'shared' | 'none'
}

export type RepoHooksResult = {
  hasHooksFile: boolean
  hooks: OrcaHooks | null
  setupRunPolicy: SetupRunPolicy
  source: 'orca.yaml' | 'legacy' | null
  globalHookDefaults?: GlobalHookDefaults | null
  setupTrust?: { contentHash: string; scriptContent: string }
}

export async function readRuntimeRepoHooks(
  hostId: ExecutionHostId,
  repoId: string
): Promise<RepoHooksResult> {
  const target = getHookInspectionTarget(hostId)
  if (target.kind !== 'environment') {
    throw new Error('Repository hook defaults are only read from runtime owners.')
  }
  return callRuntimeRpc<RepoHooksResult>(
    target,
    'repo.hooks',
    { repo: repoId },
    { timeoutMs: 15_000 }
  )
}

/** Whether hooks for a repo owned by this host execute on a runtime environment. */
export function isRuntimeEnvironmentHost(hostId: ExecutionHostId): boolean {
  return ipcOrRuntimeTargetForHostId(hostId)?.kind === 'environment'
}

export async function checkRuntimeHooks(
  hostId: ExecutionHostId,
  repoId: string
): Promise<HookCheckResult> {
  const target = getHookInspectionTarget(hostId)
  if (target.kind !== 'environment') {
    return window.api.hooks.check({ repoId, hostId })
  }
  return callRuntimeRpc<HookCheckResult>(
    target,
    'repo.hooksCheck',
    { repo: repoId },
    { timeoutMs: 15_000 }
  )
}

export async function inspectRuntimeSetupScriptImports(
  hostId: ExecutionHostId,
  repoId: string
): Promise<SetupScriptImportCandidate[]> {
  const target = getHookInspectionTarget(hostId)
  if (target.kind !== 'environment') {
    return window.api.hooks.inspectSetupScriptImports({ repoId, hostId })
  }
  return callRuntimeRpc<SetupScriptImportCandidate[]>(
    target,
    'repo.setupScriptImports',
    { repo: repoId },
    { timeoutMs: 15_000 }
  )
}

export async function readRuntimeIssueCommand(
  hostId: ExecutionHostId,
  repoId: string
): Promise<IssueCommandReadResult> {
  const target = getHookInspectionTarget(hostId)
  if (target.kind !== 'environment') {
    return window.api.hooks.readIssueCommand({ repoId, hostId })
  }
  return callRuntimeRpc<IssueCommandReadResult>(
    target,
    'repo.issueCommandRead',
    { repo: repoId },
    { timeoutMs: 15_000 }
  )
}

export async function writeRuntimeIssueCommand(
  hostId: ExecutionHostId,
  repoId: string,
  content: string
): Promise<void> {
  const target = getHookInspectionTarget(hostId)
  if (target.kind !== 'environment') {
    await window.api.hooks.writeIssueCommand({ repoId, content, hostId })
    return
  }
  await callRuntimeRpc(
    target,
    'repo.issueCommandWrite',
    { repo: repoId, content },
    { timeoutMs: 15_000 }
  )
}

import type { GlabExecOptions } from '../git/command-runner/glab-exec-file'
import { createGitlabProjectHookClient } from '../gitlab/gitlab-project-hooks'
import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  getProjectBinding,
  removeProjectBinding as removeProjectBindingRow,
  setProjectBindingProgress
} from './forge-inbox-project-binding'
import {
  getProjectEventRepoLinkByBinding,
  removeProjectEventRepoLinkForBinding
} from './forge-inbox-project-event-link'

type Exec = (
  args: string[],
  options?: GlabExecOptions
) => Promise<{ stdout: string; stderr: string }>

export type RemoveProjectBindingResult =
  | { ok: true; bindingId: string; removedHook: boolean }
  | { ok: false; bindingId: string; code: string }

export async function removeProjectBinding(
  ctx: ForgeLedgerContext,
  input: {
    bindingId: string
    /** Trusted resolution of the repo's current Git root; the stored path may predate a move. */
    repoPath?: string
    connectionId?: string | null
    signal?: AbortSignal
    exec?: Exec
  }
): Promise<RemoveProjectBindingResult> {
  const binding = getProjectBinding(ctx, input.bindingId)
  if (!binding) {
    return { ok: true, bindingId: input.bindingId, removedHook: false }
  }
  const owner = getProjectEventRepoLinkByBinding(ctx, binding.bindingId)
  // Why no hookId guard: a lost creation response leaves a hook the ledger never recorded.
  const client = createGitlabProjectHookClient({
    host: binding.gitlabHost,
    projectId: String(binding.gitlabProjectId),
    repoPath: input.repoPath ?? binding.projectPath,
    connectionId: input.connectionId,
    exec: input.exec
  })
  const removed = await client.remove(
    { bindingId: binding.bindingId, hookId: binding.hookId ?? undefined },
    input.signal
  )
  const current = getProjectBinding(ctx, binding.bindingId)
  const currentOwner = getProjectEventRepoLinkByBinding(ctx, binding.bindingId)
  // A remote response belongs to the captured owner, not a repo that adopted it during the await.
  if (
    current === null ||
    currentOwner?.repoId !== owner?.repoId ||
    currentOwner?.createdAt !== owner?.createdAt ||
    current.projectPath !== binding.projectPath ||
    current.updatedAt !== binding.updatedAt ||
    current.state !== binding.state
  ) {
    return removed.ok
      ? { ok: true, bindingId: binding.bindingId, removedHook: binding.hookId !== null }
      : { ok: false, bindingId: binding.bindingId, code: removed.code }
  }
  if (!removed.ok) {
    // Why drop the link but keep the row: the repo is going away, so its id must not block a
    // re-add of this project; the failed row stays visible and its stored path drives the retry.
    removeProjectEventRepoLinkForBinding(ctx, binding.bindingId)
    setProjectBindingProgress(ctx, binding.bindingId, {
      state: 'failed',
      failure: { phase: 'registering', code: 'cleanup-failed', retryable: true }
    })
    return { ok: false, bindingId: binding.bindingId, code: removed.code }
  }
  removeProjectEventRepoLinkForBinding(ctx, binding.bindingId)
  removeProjectBindingRow(ctx, binding.bindingId)
  return { ok: true, bindingId: binding.bindingId, removedHook: binding.hookId !== null }
}

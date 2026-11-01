import type { GlabApiExec } from './forge-inbox-glab-api-requester'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeProjectEventItemStateObserver } from './forge-inbox-owner-service-options'
import { observeProjectEventItemState } from './forge-inbox-project-event-item-state-observation'

/** The host's state verifier for a hook-reported change the context dedupe would swallow. */
export function createForgeProjectEventItemStateObserver(
  ledger: ForgeInboxLedger,
  exec?: GlabApiExec
): ForgeProjectEventItemStateObserver {
  return (claim, subject, signal) => {
    if (claim.itemId === null) {
      return Promise.resolve(null)
    }
    const ctx = ledger.ledgerContext()
    const binding = ctx.db
      .prepare(
        'SELECT gitlab_host, project_path, gitlab_project_id, gitlab_path FROM project_bindings WHERE binding_id = ?'
      )
      .get(claim.bindingId)
    if (binding === undefined) {
      return Promise.resolve(null)
    }
    return observeProjectEventItemState(
      ctx,
      {
        host: String(binding.gitlab_host),
        repoPath: String(binding.project_path),
        projectId: Number(binding.gitlab_project_id),
        // Admission pinned the delivery's project to this path; the binding speaks for it.
        projectIdText: String(binding.gitlab_path),
        bindingId: claim.bindingId
      },
      claim.itemId,
      subject.iid,
      { ...(exec === undefined ? {} : { exec }), ...(signal === undefined ? {} : { signal }) }
    )
  }
}

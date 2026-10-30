import { ForgeInboxOwnerNotRunningError } from '../forge-inbox/forge-inbox-owner-errors'
import type { ForgeInboxOwnerService } from '../forge-inbox/forge-inbox-owner-service'

/** Holds the one owner service of this runtime, attached before it starts; a stop requested earlier refuses any attach. */
export class RuntimeForgeInboxController {
  private attached: ForgeInboxOwnerService | null = null
  private stopRequested = false

  attach(service: ForgeInboxOwnerService): void {
    if (this.attached) {
      throw new Error('forge_inbox_already_attached')
    }
    if (this.stopRequested) {
      throw new ForgeInboxOwnerNotRunningError()
    }
    this.attached = service
  }

  service(): ForgeInboxOwnerService {
    if (!this.attached) {
      throw new Error('runtime_unavailable')
    }
    return this.attached
  }

  serviceIfAttached(): ForgeInboxOwnerService | null {
    return this.attached
  }

  /** Repo removal must never fail on GitLab: the owner reports the failure and keeps a retryable row. */
  async removeProjectEvent(repoId: string): Promise<void> {
    const result = await this.attached?.removeProjectEvent(repoId)
    if (result && !result.ok) {
      console.warn('[runtime] project event hook cleanup failed', result.code)
    }
  }

  /** Busy on enabled listener intent (even if the bind failed) or work in flight; parked and finished rows are not work. A pending retry keeps an orcad host alive until its attempt bound. */
  keepsHostBusy(): boolean {
    const service = this.attached
    return service !== null && (service.status().listener.enabled || !service.idle())
  }

  stopForgeInboxService(): Promise<void> {
    this.stopRequested = true
    return this.attached?.stop() ?? Promise.resolve()
  }
}

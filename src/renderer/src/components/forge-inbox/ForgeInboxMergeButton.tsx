import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ForgeItemMergeFailure } from '../../../../shared/forge-inbox-rpc-types'
import { mergeForgeInboxItem } from '@/runtime/forge-inbox-client'

/** Every refusal is a fixed host code, so this copy never echoes backend text. */
function failureLabel(reason: ForgeItemMergeFailure): string {
  switch (reason) {
    case 'not-found':
      return translate(
        'auto.components.forge-inbox.ForgeInboxMergeButton.notFound',
        'This item no longer exists.'
      )
    case 'not-a-merge-request':
      return translate(
        'auto.components.forge-inbox.ForgeInboxMergeButton.notMergeRequest',
        'Only merge requests can be merged.'
      )
    case 'not-open':
      return translate(
        'auto.components.forge-inbox.ForgeInboxMergeButton.notOpen',
        'This merge request is no longer open.'
      )
    case 'no-recommendation':
      return translate(
        'auto.components.forge-inbox.ForgeInboxMergeButton.noRecommendation',
        'The agent left no recommendation to confirm.'
      )
    case 'not-recommended':
      return translate(
        'auto.components.forge-inbox.ForgeInboxMergeButton.notRecommended',
        'The agent did not recommend merging this change.'
      )
    case 'no-expected-sha':
      return translate(
        'auto.components.forge-inbox.ForgeInboxMergeButton.noExpectedSha',
        'The reviewed commit is unknown, so nothing was merged.'
      )
    case 'draft':
      return translate(
        'auto.components.forge-inbox.ForgeInboxMergeButton.draft',
        'The merge request is still a draft.'
      )
    case 'head-moved':
      return translate(
        'auto.components.forge-inbox.ForgeInboxMergeButton.headMoved',
        'New commits arrived after the review. Review them first.'
      )
    case 'not-mergeable':
      return translate(
        'auto.components.forge-inbox.ForgeInboxMergeButton.notMergeable',
        'GitLab refused the merge: conflicts, approvals or the pipeline blocked it.'
      )
    case 'unauthorized':
    case 'forbidden':
      return translate(
        'auto.components.forge-inbox.ForgeInboxMergeButton.forbidden',
        'The GitLab credential cannot merge this project.'
      )
    case 'no-credential':
      return translate(
        'auto.components.forge-inbox.ForgeInboxMergeButton.noCredential',
        'No GitLab write credential is configured.'
      )
    case 'stale-config':
      return translate(
        'auto.components.forge-inbox.ForgeInboxMergeButton.staleConfig',
        'The GitLab settings changed. Try again.'
      )
    case 'rate-limited':
      return translate(
        'auto.components.forge-inbox.ForgeInboxMergeButton.rateLimited',
        'GitLab rate-limited the request. Try again later.'
      )
    case 'network':
    case 'bad-response':
      return translate(
        'auto.components.forge-inbox.ForgeInboxMergeButton.unknown',
        'GitLab gave no usable answer, so the merge result is unknown. Check the merge request before retrying.'
      )
    case 'cancelled':
      return translate(
        'auto.components.forge-inbox.ForgeInboxMergeButton.cancelled',
        'The merge was cancelled.'
      )
  }
}

/**
 * A person confirms the recommendation, never a fresh write: the dialog names the merge request and
 * the host merges the commit the agent reviewed, or refuses when that commit moved.
 */
export function ForgeInboxMergeButton({
  ownerHostId,
  ownerTarget,
  itemId,
  instanceId,
  iid,
  reason,
  onMerged
}: {
  ownerHostId: string | null
  ownerTarget: RuntimeClientTarget
  itemId: number
  instanceId: string | undefined
  iid: number
  reason: string | null
  onMerged: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<ForgeItemMergeFailure | null>(null)
  const [merged, setMerged] = useState(false)

  async function submit(): Promise<void> {
    if (ownerHostId === null || pending) {
      return
    }
    setPending(true)
    setFailure(null)
    try {
      const result = await mergeForgeInboxItem(ownerHostId, itemId, instanceId, ownerTarget)
      if (result.ok) {
        setMerged(true)
        setOpen(false)
        onMerged()
      } else {
        setFailure(result.reason)
      }
    } catch {
      setFailure('bad-response')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="xs"
          variant="default"
          disabled={pending || merged}
          onClick={() => {
            setFailure(null)
            setOpen(true)
          }}
        >
          {translate('auto.components.forge-inbox.ForgeInboxMergeButton.action', 'Confirm merge')}
        </Button>
        {merged ? (
          <span className="text-xs text-muted-foreground">
            {translate(
              'auto.components.forge-inbox.ForgeInboxMergeButton.merged',
              'Merge requested. GitLab will report the result here.'
            )}
          </span>
        ) : null}
        {failure === null ? null : (
          <span className="text-xs text-destructive">{failureLabel(failure)}</span>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent surface="security" className="max-w-md sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {translate(
                'auto.components.forge-inbox.ForgeInboxMergeButton.title',
                'Merge merge request !{{iid}}?',
                { iid }
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.forge-inbox.ForgeInboxMergeButton.description',
                'The host merges the exact commit the agent reviewed. If that commit moved, nothing is merged.'
              )}
            </DialogDescription>
          </DialogHeader>
          {reason === null ? null : <p className="text-xs text-muted-foreground">{reason}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              {translate('auto.components.forge-inbox.ForgeInboxMergeButton.cancel', 'Cancel')}
            </Button>
            <Button type="button" size="xs" disabled={pending} onClick={() => void submit()}>
              {pending
                ? translate('auto.components.forge-inbox.ForgeInboxMergeButton.pending', 'Merging…')
                : translate('auto.components.forge-inbox.ForgeInboxMergeButton.confirm', 'Merge')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

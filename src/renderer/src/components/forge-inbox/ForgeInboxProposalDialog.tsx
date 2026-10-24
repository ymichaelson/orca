import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type {
  ForgeProposalPreview,
  ForgeProposalView
} from '../../../../shared/forge-inbox-rpc-types'
import { translate } from '@/i18n/i18n'
import {
  approveForgeInboxComment,
  approveForgeInboxPatch,
  approveForgeInboxPush,
  discussForgeInboxRun,
  readForgeInboxProposal,
  rejectForgeInboxProposal
} from '@/runtime/forge-inbox-client'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Textarea } from '../ui/textarea'
import { forgeApprovalFailureMessage } from './forge-inbox-approval-messages'
import { forgeDiscussRefusalMessage } from './forge-inbox-discuss-messages'
import { formatForgeDateTime } from './forge-inbox-display'
import {
  ProposalBody,
  approveLabel,
  proposalKindLabel,
  targetLabel
} from './forge-inbox-proposal-preview-parts'

/** Model output and the exact draft are rendered as plain text: neither may become clickable HTML. */
export function ForgeInboxProposalDialog({
  ownerHostId,
  instanceId,
  proposal,
  onClose,
  onChanged
}: {
  ownerHostId: string
  instanceId: string
  proposal: ForgeProposalView | null
  onClose: () => void
  onChanged: () => void
}): React.JSX.Element {
  return (
    <Dialog open={proposal !== null} onOpenChange={(open) => !open && onClose()}>
      {proposal !== null ? (
        <ProposalReview
          key={proposal.id}
          ownerHostId={ownerHostId}
          instanceId={instanceId}
          proposal={proposal}
          onClose={onClose}
          onChanged={onChanged}
        />
      ) : null}
    </Dialog>
  )
}

function ProposalReview({
  ownerHostId,
  instanceId,
  proposal,
  onClose,
  onChanged
}: {
  ownerHostId: string
  instanceId: string
  proposal: ForgeProposalView
  onClose: () => void
  onChanged: () => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<ForgeProposalPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'approve' | 'reject' | 'discuss' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [discussOpen, setDiscussOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [reply, setReply] = useState<string | null>(null)
  const [discussError, setDiscussError] = useState<string | null>(null)

  const loadPreview = useCallback(() => {
    setPreviewError(null)
    readForgeInboxProposal(ownerHostId, proposal.id, instanceId)
      .then((view) => setPreview(view.proposal))
      .catch((error: unknown) =>
        setPreviewError(error instanceof Error ? error.message : String(error))
      )
  }, [instanceId, ownerHostId, proposal.id])

  useEffect(() => loadPreview(), [loadPreview])

  const pending = preview?.status === 'pending'
  const canApprove = pending && preview.kind !== 'unknown' && busy === null

  async function approve(): Promise<void> {
    if (!preview || preview.kind === 'unknown') {
      return
    }
    setBusy('approve')
    setActionError(null)
    try {
      const input = {
        proposalId: proposal.id,
        instanceId,
        expectedHash: preview.hash,
        expectedRevision: preview.revision,
        expectedPolicyGeneration: preview.policyGeneration
      }
      const outcome =
        preview.kind === 'comment'
          ? await approveForgeInboxComment(ownerHostId, input)
          : preview.kind === 'patch'
            ? await approveForgeInboxPatch(ownerHostId, input)
            : await approveForgeInboxPush(ownerHostId, input)
      if (outcome.ok) {
        onChanged()
        onClose()
        return
      }
      setActionError(forgeApprovalFailureMessage(outcome.reason))
      // Why reload: a refusal may mean the proposal is now consumed or stale, which the badge must show.
      loadPreview()
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function reject(): Promise<void> {
    setBusy('reject')
    setActionError(null)
    try {
      const outcome = await rejectForgeInboxProposal(ownerHostId, proposal.id, instanceId)
      if (outcome.ok) {
        onChanged()
        onClose()
        return
      }
      setActionError(
        outcome.reason === 'not-found'
          ? forgeApprovalFailureMessage('not-found')
          : forgeApprovalFailureMessage('not-pending')
      )
      loadPreview()
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function discuss(): Promise<void> {
    if (message.trim() === '') {
      setDiscussError(forgeDiscussRefusalMessage('message-empty'))
      return
    }
    setBusy('discuss')
    setDiscussError(null)
    setReply(null)
    try {
      const outcome = await discussForgeInboxRun(ownerHostId, {
        runId: proposal.runId,
        instanceId,
        message
      })
      if (outcome.kind === 'reply') {
        setReply(outcome.text)
        setMessage('')
      } else if (outcome.kind === 'unknown') {
        setDiscussError(
          translate(
            'auto.components.forge-inbox.ForgeInboxProposalDialog.discussUnconfirmed',
            'The message was handed over, but the answer could not be confirmed.'
          )
        )
      } else {
        setDiscussError(forgeDiscussRefusalMessage(outcome.reason))
      }
    } catch (error: unknown) {
      setDiscussError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <DialogContent surface="security" scrollable className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>
          {translate(
            'auto.components.forge-inbox.ForgeInboxProposalDialog.title',
            'Review before sending'
          )}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'auto.components.forge-inbox.ForgeInboxProposalDialog.description',
            'The agent proposes this exact {{kind}}. Nothing happens until you approve it.',
            { kind: proposalKindLabel(preview?.kind ?? 'unknown').toLowerCase() }
          )}
        </DialogDescription>
      </DialogHeader>

      {previewError !== null ? (
        <p className="mt-3 text-xs text-destructive">{previewError}</p>
      ) : null}
      {preview === null && previewError === null ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {translate(
            'auto.components.forge-inbox.ForgeInboxProposalDialog.loading',
            'Loading the exact draft…'
          )}
        </p>
      ) : null}

      {preview !== null ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={preview.status === 'pending' ? 'dot' : 'outline'}>
              {preview.status}
            </Badge>
            <span className="text-muted-foreground">{targetLabel(preview)}</span>
            <span className="text-2xs text-muted-foreground">
              {formatForgeDateTime(preview.createdAt)}
            </span>
          </div>

          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-2xs">
            <dt className="text-muted-foreground">
              {translate(
                'auto.components.forge-inbox.ForgeInboxProposalDialog.versions',
                'Version'
              )}
            </dt>
            <dd className="text-foreground/85">
              {translate(
                'auto.components.forge-inbox.ForgeInboxProposalDialog.revisionPolicy',
                'revision {{revision}} · policy generation {{policyGeneration}}',
                { revision: preview.revision, policyGeneration: preview.policyGeneration }
              )}
            </dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.forge-inbox.ForgeInboxProposalDialog.hash', 'Hash')}
            </dt>
            <dd className="break-all font-mono text-foreground/85">{preview.hash ?? '—'}</dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.forge-inbox.ForgeInboxProposalDialog.host', 'Host')}
            </dt>
            <dd className="break-all font-mono text-foreground/85">{ownerHostId}</dd>
            {preview.kind === 'comment' ? (
              <>
                <dt className="text-muted-foreground">
                  {translate(
                    'auto.components.forge-inbox.ForgeInboxProposalDialog.head',
                    'Reviewed head'
                  )}
                </dt>
                <dd className="break-all font-mono text-foreground/85">{preview.headSha ?? '—'}</dd>
              </>
            ) : null}
          </dl>

          <ProposalBody preview={preview} />
        </>
      ) : null}

      {discussOpen ? (
        <div className="mt-4 flex flex-col gap-2">
          <Textarea
            value={message}
            rows={3}
            placeholder={translate(
              'auto.components.forge-inbox.ForgeInboxProposalDialog.discussPlaceholder',
              'Ask the analysis session about this proposal…'
            )}
            onChange={(event) => setMessage(event.target.value)}
            disabled={busy !== null}
          />
          {discussError !== null ? (
            <p role="alert" className="text-xs text-destructive">
              {discussError}
            </p>
          ) : null}
          {reply !== null ? (
            <p className="scrollbar-sleek max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2 text-xs leading-5 text-foreground/85">
              {reply}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={discuss}>
              {busy === 'discuss' ? <Loader2 className="animate-spin" /> : null}
              {translate(
                'auto.components.forge-inbox.ForgeInboxProposalDialog.discussSend',
                'Send to the session'
              )}
            </Button>
          </div>
        </div>
      ) : null}

      {actionError !== null ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {actionError}
        </p>
      ) : null}

      <DialogFooter className="mt-4">
        <Button
          variant="ghost"
          disabled={busy !== null}
          onClick={() => setDiscussOpen((open) => !open)}
        >
          {translate('auto.components.forge-inbox.ForgeInboxProposalDialog.discuss', 'Discuss')}
        </Button>
        <Button variant="outline" disabled={busy !== null || !pending} onClick={reject}>
          {busy === 'reject' ? <Loader2 className="animate-spin" /> : null}
          {translate('auto.components.forge-inbox.ForgeInboxProposalDialog.reject', 'Reject')}
        </Button>
        <Button variant="ghost" disabled={busy !== null} onClick={onClose}>
          {translate('auto.components.forge-inbox.ForgeInboxProposalDialog.close', 'Close')}
        </Button>
        <Button disabled={!canApprove} onClick={approve}>
          {busy === 'approve' ? <Loader2 className="animate-spin" /> : null}
          {approveLabel(preview?.kind ?? 'unknown')}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

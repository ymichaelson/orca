import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { ForgeProposalPreview } from '../../../../shared/forge-inbox-rpc-types'
import { translate } from '@/i18n/i18n'
import { readForgeInboxProposalDiff } from '@/runtime/forge-inbox-client'
import { Button } from '../ui/button'
import { forgeApprovalFailureMessage } from './forge-inbox-approval-messages'

export function proposalKindLabel(kind: ForgeProposalPreview['kind']): string {
  switch (kind) {
    case 'comment':
      return translate(
        'auto.components.forge-inbox.ForgeInboxProposalDialog.kindComment',
        'Comment'
      )
    case 'patch':
      return translate(
        'auto.components.forge-inbox.ForgeInboxProposalDialog.kindPatch',
        'File changes'
      )
    case 'push':
      return translate('auto.components.forge-inbox.ForgeInboxProposalDialog.kindPush', 'Push')
    case 'unknown':
      return translate(
        'auto.components.forge-inbox.ForgeInboxProposalDialog.kindUnknown',
        'Unrecognised action'
      )
  }
}

/** Each kind reaches a different broker, so the button names the exact outcome it approves. */
export function approveLabel(kind: ForgeProposalPreview['kind']): string {
  switch (kind) {
    case 'comment':
      return translate(
        'auto.components.forge-inbox.ForgeInboxProposalDialog.approveComment',
        'Approve and send comment'
      )
    case 'patch':
      return translate(
        'auto.components.forge-inbox.ForgeInboxProposalDialog.approvePatch',
        'Approve and apply changes'
      )
    case 'push':
      return translate(
        'auto.components.forge-inbox.ForgeInboxProposalDialog.approvePush',
        'Approve and push'
      )
    case 'unknown':
      return translate('auto.components.forge-inbox.ForgeInboxProposalDialog.approve', 'Approve')
  }
}

export function targetLabel(preview: ForgeProposalPreview): string {
  if (preview.kind === 'comment') {
    const targetKind =
      preview.target.kind === 'merge_request'
        ? translate(
            'auto.components.forge-inbox.ForgeInboxProposalDialog.mergeRequest',
            'merge request'
          )
        : translate('auto.components.forge-inbox.ForgeInboxProposalDialog.issue', 'issue')
    return translate(
      'auto.components.forge-inbox.ForgeInboxProposalDialog.commentTarget',
      '{{kind}} !{{iid}} · project {{projectId}}',
      { kind: targetKind, iid: preview.target.iid, projectId: preview.target.projectId }
    )
  }
  if (preview.kind === 'patch' || preview.kind === 'push') {
    return translate(
      'auto.components.forge-inbox.ForgeInboxProposalDialog.projectTarget',
      'project {{projectId}}',
      { projectId: preview.target.projectId }
    )
  }
  return translate(
    'auto.components.forge-inbox.ForgeInboxProposalDialog.unknownTarget',
    'This build cannot read this proposal’s target.'
  )
}

export function ProposalBody({ preview }: { preview: ForgeProposalPreview }): React.JSX.Element {
  if (preview.kind === 'comment') {
    return (
      <pre className="scrollbar-sleek mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-5 text-foreground/85">
        {preview.body}
      </pre>
    )
  }
  if (preview.kind === 'patch') {
    return (
      <>
        <p className="mt-3 text-xs text-muted-foreground">
          {translate(
            'auto.components.forge-inbox.ForgeInboxProposalDialog.patchDetails',
            'branch {{branch}} · base {{base}}',
            { branch: preview.branch, base: preview.baseSha.slice(0, 12) }
          )}
        </p>
        <ul className="mt-2 flex flex-col gap-1 text-xs">
          {preview.files.map((file) => (
            <li key={file.path} className="flex items-baseline gap-2">
              <span className="font-mono text-2xs text-foreground/80">{file.op}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{file.path}</span>
              <span className="text-2xs text-muted-foreground">{file.contentBytes} B</span>
            </li>
          ))}
        </ul>
      </>
    )
  }
  if (preview.kind === 'push') {
    return (
      <>
        <p className="mt-3 text-xs text-muted-foreground">
          {translate(
            'auto.components.forge-inbox.ForgeInboxProposalDialog.pushDetails',
            'branch {{branch}} · expected head {{head}} · commit {{commit}}',
            {
              branch: preview.branch,
              head: preview.expectedHeadSha.slice(0, 12),
              commit: preview.commitSha.slice(0, 12)
            }
          )}
        </p>
        <p className="mt-3 text-2xs text-muted-foreground">
          {translate(
            'auto.components.forge-inbox.ForgeInboxProposalDialog.pushMessage',
            'Commit message'
          )}
        </p>
        <pre className="scrollbar-sleek mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-5 text-foreground/85">
          {preview.message}
        </pre>
      </>
    )
  }
  return (
    <p className="mt-3 text-xs text-muted-foreground">
      {translate(
        'auto.components.forge-inbox.ForgeInboxProposalDialog.notApprovable',
        'This proposal cannot be approved from this build.'
      )}
    </p>
  )
}

type DiffState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'shown'; text: string }
  | { status: 'refused'; message: string }

/**
 * The diff is rendered by the host from the base the manifest pins, and only shown when it
 * belongs to the same draft hash the dialog displays; anything else is refused, never patched in.
 */
export function ProposalDiffView({
  ownerHostId,
  instanceId,
  proposalId,
  hash
}: {
  ownerHostId: string
  instanceId: string
  proposalId: number
  hash: string
}): React.JSX.Element {
  const [state, setState] = useState<DiffState>({ status: 'idle' })

  async function toggle(): Promise<void> {
    if (state.status === 'shown') {
      setState({ status: 'idle' })
      return
    }
    if (state.status === 'loading') {
      return
    }
    setState({ status: 'loading' })
    try {
      const view = await readForgeInboxProposalDiff(ownerHostId, proposalId, instanceId)
      if (view.diff === null) {
        setState({ status: 'refused', message: forgeApprovalFailureMessage('not-found') })
        return
      }
      if (!view.diff.ok) {
        setState({ status: 'refused', message: forgeApprovalFailureMessage(view.diff.reason) })
        return
      }
      if (view.diff.hash !== hash) {
        setState({ status: 'refused', message: forgeApprovalFailureMessage('draft-mismatch') })
        return
      }
      setState({ status: 'shown', text: view.diff.text })
    } catch (error: unknown) {
      setState({
        status: 'refused',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" disabled={state.status === 'loading'} onClick={toggle}>
          {state.status === 'loading' ? <Loader2 className="animate-spin" /> : null}
          {state.status === 'shown'
            ? translate(
                'auto.components.forge-inbox.ForgeInboxProposalDialog.hideDiff',
                'Hide exact diff'
              )
            : translate(
                'auto.components.forge-inbox.ForgeInboxProposalDialog.showDiff',
                'Show exact diff'
              )}
        </Button>
      </div>
      {state.status === 'refused' ? (
        <p role="alert" className="text-xs text-destructive">
          {state.message}
        </p>
      ) : null}
      {state.status === 'shown' ? (
        <pre className="scrollbar-sleek max-h-80 overflow-auto whitespace-pre rounded-md border border-border bg-muted/30 p-3 font-mono text-2xs leading-5 text-foreground/85">
          {state.text}
        </pre>
      ) : null}
    </div>
  )
}

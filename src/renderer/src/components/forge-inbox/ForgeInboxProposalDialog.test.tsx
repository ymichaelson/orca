// @vitest-environment happy-dom

import React, { type ReactNode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ForgeProposalPreview,
  ForgeProposalView
} from '../../../../shared/forge-inbox-rpc-types'

const mocks = vi.hoisted(() => ({
  readProposal: vi.fn(),
  approveComment: vi.fn(),
  approvePatch: vi.fn(),
  approvePush: vi.fn(),
  reject: vi.fn(),
  discuss: vi.fn()
}))

vi.mock('@/runtime/forge-inbox-client', () => ({
  readForgeInboxProposal: mocks.readProposal,
  approveForgeInboxComment: mocks.approveComment,
  approveForgeInboxPatch: mocks.approvePatch,
  approveForgeInboxPush: mocks.approvePush,
  rejectForgeInboxProposal: mocks.reject,
  discussForgeInboxRun: mocks.discuss
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children?: ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children?: ReactNode }) =>
    React.createElement('footer', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) =>
    React.createElement('header', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => React.createElement('h2', null, children)
}))

import { ForgeInboxProposalDialog } from './ForgeInboxProposalDialog'

const PROPOSAL: ForgeProposalView = {
  id: 812,
  runId: 5,
  itemId: 3,
  revision: 2,
  policyGeneration: 1,
  status: 'pending',
  createdAt: 1_700_000_000_000,
  resolvedAt: null
}

const HASH = 'a'.repeat(64)
const BASE = 'b'.repeat(40)
const INSTANCE = 'instance-1'

function patchPreview(): ForgeProposalPreview {
  return {
    kind: 'patch',
    proposalId: PROPOSAL.id,
    status: 'pending',
    revision: PROPOSAL.revision,
    policyGeneration: PROPOSAL.policyGeneration,
    createdAt: PROPOSAL.createdAt,
    resolvedAt: null,
    hash: HASH,
    target: { instanceId: INSTANCE, projectId: '42' },
    baseSha: BASE,
    branch: 'main',
    files: [
      {
        op: 'update',
        path: 'src/a.ts',
        contentBytes: 4,
        baseSha256: 'c'.repeat(64),
        resultSha256: 'd'.repeat(64)
      }
    ]
  }
}

function pushPreview(): ForgeProposalPreview {
  return {
    kind: 'push',
    proposalId: PROPOSAL.id,
    status: 'pending',
    revision: PROPOSAL.revision,
    policyGeneration: PROPOSAL.policyGeneration,
    createdAt: PROPOSAL.createdAt,
    resolvedAt: null,
    hash: HASH,
    target: { instanceId: INSTANCE, projectId: '42' },
    branch: 'main',
    expectedHeadSha: BASE,
    commitSha: 'e'.repeat(40),
    message: 'Forge change\n'
  }
}

function unknownPreview(): ForgeProposalPreview {
  return {
    kind: 'unknown',
    proposalId: PROPOSAL.id,
    status: 'pending',
    revision: PROPOSAL.revision,
    policyGeneration: PROPOSAL.policyGeneration,
    createdAt: PROPOSAL.createdAt,
    resolvedAt: null,
    hash: null
  }
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(label)
  )
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`no button matching ${label}`)
  }
  return found
}

describe('ForgeInboxProposalDialog', () => {
  let container: HTMLDivElement
  let root: Root
  const onClose = vi.fn()
  const onChanged = vi.fn()

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    onClose.mockReset()
    onChanged.mockReset()
    for (const mock of Object.values(mocks)) {
      mock.mockReset()
    }
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function render(preview: ForgeProposalPreview): Promise<void> {
    mocks.readProposal.mockResolvedValue({ ownerHostId: 'host-1', proposal: preview })
    await act(async () => {
      root.render(
        <ForgeInboxProposalDialog
          ownerHostId="host-1"
          instanceId={INSTANCE}
          proposal={PROPOSAL}
          onClose={onClose}
          onChanged={onChanged}
        />
      )
    })
  }

  it('approves a file change through the patch broker, not the comment broker', async () => {
    mocks.approvePatch.mockResolvedValue({
      ownerHostId: 'host-1',
      ok: true,
      receiptId: 31,
      written: ['src/a.ts'],
      removed: []
    })
    await render(patchPreview())

    await act(async () => button(container, 'Approve and apply changes').click())

    expect(mocks.approvePatch).toHaveBeenCalledWith('host-1', {
      proposalId: PROPOSAL.id,
      instanceId: INSTANCE,
      expectedHash: HASH,
      expectedRevision: PROPOSAL.revision,
      expectedPolicyGeneration: PROPOSAL.policyGeneration
    })
    expect(mocks.approveComment).not.toHaveBeenCalled()
    expect(mocks.approvePush).not.toHaveBeenCalled()
    expect(onChanged).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps an unconfirmed push open and says it may have happened', async () => {
    mocks.approvePush.mockResolvedValue({
      ownerHostId: 'host-1',
      ok: false,
      reason: 'unconfirmed',
      receiptId: 44
    })
    await render(pushPreview())

    await act(async () => button(container, 'Approve and push').click())

    expect(mocks.approvePush).toHaveBeenCalledTimes(1)
    expect(mocks.approveComment).not.toHaveBeenCalled()
    expect(mocks.approvePatch).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('may have succeeded')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('cannot approve a proposal this build cannot read', async () => {
    await render(unknownPreview())

    const approve = button(container, 'Approve')
    expect(approve.disabled).toBe(true)
    await act(async () => approve.click())
    expect(mocks.approveComment).not.toHaveBeenCalled()
    expect(mocks.approvePatch).not.toHaveBeenCalled()
    expect(mocks.approvePush).not.toHaveBeenCalled()
  })
})

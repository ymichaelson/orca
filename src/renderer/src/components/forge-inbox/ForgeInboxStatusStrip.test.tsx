// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForgeInboxStatus } from '../../../../shared/forge-inbox-rpc-types'
import { ForgeInboxStatusStrip } from './ForgeInboxStatusStrip'

function running(error: string | null): ForgeInboxStatus {
  return {
    ownerHostId: 'owner-1',
    available: true,
    phase: 'running',
    running: true,
    dormant: false,
    listener: { enabled: true, listening: false, port: null, error },
    work: { pending: 0, needsAuth: 0, nextAttemptAtMs: null, draining: false }
  }
}

describe('ForgeInboxStatusStrip', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(props: Partial<Parameters<typeof ForgeInboxStatusStrip>[0]>): void {
    act(() =>
      root.render(
        <ForgeInboxStatusStrip
          status={null}
          error={null}
          loading={false}
          onRetry={vi.fn()}
          {...props}
        />
      )
    )
  }

  it('words a known listener code and offers the webhook settings', () => {
    const open = vi.fn()
    render({ status: running('EADDRINUSE'), onOpenReceiverSettings: open })

    expect(container.textContent).toContain('The port is already in use')
    expect(container.textContent).not.toContain('EADDRINUSE')
    const link = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('webhook settings')
    )
    act(() => link?.click())
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('never shows an unknown listener message or a raw status failure', () => {
    render({ status: running('connect ECONNRESET token=glpat-secret') })
    expect(container.textContent).not.toContain('glpat-secret')
    expect(container.textContent).toContain('The listener failed to start.')

    render({ error: 'ENOENT /Users/me/.orca/secret-path' })
    expect(container.textContent).not.toContain('secret-path')
    expect(container.textContent).toContain('Could not read the inbox status')
  })

  it('offers no settings link while the listener is healthy', () => {
    render({ status: running(null), onOpenReceiverSettings: vi.fn() })
    expect(container.textContent).not.toContain('webhook settings')
  })
})

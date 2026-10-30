// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForgeItemDetailView } from '../../../../shared/forge-inbox-rpc-types'
import { ForgeInboxDetail } from './ForgeInboxDetail'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const detail: ForgeItemDetailView = {
  item: {
    id: 7,
    hostId: 'owner',
    instanceId: 'gitlab:test',
    projectId: 'group/demo',
    kind: 'issue',
    iid: 7,
    title: 'Issue seven',
    state: 'opened',
    currentRevision: 1,
    activitySeq: 1,
    createdAt: 1,
    updatedAt: 1,
    unread: true,
    archived: false
  },
  revisions: [],
  runs: [],
  proposals: []
}

describe('Inbox archive action', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it.each([
    ['reject', false],
    ['not applied', false],
    ['reject', true],
    ['not applied', true]
  ] as const)(
    'shows safe failure and allows retry after %s with archived=%s',
    async (failure, archived) => {
      const pending = deferred<boolean>()
      const archive = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(true)
      act(() =>
        root.render(
          <ForgeInboxDetail
            ownerTarget={{ kind: 'local' }}
            ownerHostId="owner"
            detail={{ ...detail, item: { ...detail.item, archived } }}
            questions={[]}
            loading={false}
            error={null}
            onChanged={() => {}}
            archiveSupported
            onSetArchived={archive}
          />
        )
      )
      const button = [...container.querySelectorAll('button')].find(
        (element) => element.textContent === (archived ? 'Unarchive' : 'Archive')
      )
      expect(button).toBeDefined()
      act(() => button?.click())
      expect(button?.disabled).toBe(true)
      act(() => button?.click())
      expect(archive).toHaveBeenCalledTimes(1)
      expect(archive).toHaveBeenCalledWith(7, !archived)
      await act(async () => {
        if (failure === 'reject') {
          pending.reject(new Error('token=secret'))
        } else {
          pending.resolve(false)
        }
      })
      expect(container.textContent).toContain('Something went wrong.')
      expect(container.textContent).not.toContain('token=secret')
      expect(button?.disabled).toBe(false)
      await act(async () => button?.click())
      expect(archive).toHaveBeenCalledTimes(2)
      expect(container.textContent).not.toContain('Something went wrong.')
    }
  )

  it('hides old actions while loading a different item', () => {
    const archive = vi.fn()
    act(() =>
      root.render(
        <ForgeInboxDetail
          ownerTarget={{ kind: 'local' }}
          ownerHostId="owner"
          detail={detail}
          questions={[]}
          loading
          error={null}
          onChanged={() => {}}
          archiveSupported
          onSetArchived={archive}
        />
      )
    )
    expect(container.textContent).not.toContain('Issue seven')
    expect(container.textContent).not.toContain('Archive')
    expect(container.textContent).toContain('Loading item')
  })
})

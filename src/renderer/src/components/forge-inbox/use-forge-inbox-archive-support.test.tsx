// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY } from '../../../../shared/forge-inbox-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  refreshLocalRuntimeCapabilities,
  setLocalRuntimeCapabilitiesForTests
} from '@/runtime/local-runtime-capabilities'
import { useForgeInboxArchiveSupport } from './use-forge-inbox-archive-support'

const supports = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: supports
}))

const LOCAL: RuntimeClientTarget = { kind: 'local' }
const REMOTE: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-remote' }
const ENV_B: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-b' }

function Probe({ target }: { target: RuntimeClientTarget }): React.JSX.Element {
  const supported = useForgeInboxArchiveSupport(target)
  return <span>{String(supported)}</span>
}

function never(): Promise<never> {
  return new Promise(() => undefined)
}

function pendingProbe(): { promise: Promise<boolean>; resolve: (value: boolean) => void } {
  let resolve: (value: boolean) => void = () => undefined
  const promise = new Promise<boolean>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  supports.mockReset().mockReturnValue(never())
})

it('recovers from a failed capability probe without remounting', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  setLocalRuntimeCapabilitiesForTests(null)
  const getStatus = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ capabilities: [FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY] })
  Object.assign(window, { api: { runtime: { getStatus } } })
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => root.render(<Probe target={LOCAL} />))
  expect(container.textContent).toBe('null')
  await act(async () => {
    await refreshLocalRuntimeCapabilities()
  })
  expect(container.textContent).toBe('true')
  act(() => root.unmount())
})

it('probes the selected host instead of borrowing the local answer', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  setLocalRuntimeCapabilitiesForTests([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
  supports.mockImplementation((environmentId: string) =>
    environmentId === 'env-remote' ? Promise.reject(new Error('offline')) : Promise.resolve(true)
  )
  const container = document.createElement('div')
  const root = createRoot(container)

  await act(async () => root.render(<Probe target={REMOTE} />))
  await act(async () => {})
  expect(container.textContent).toBe('null')
  expect(supports).toHaveBeenCalledWith('env-remote', FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY)

  await act(async () => root.render(<Probe target={ENV_B} />))
  await act(async () => {})
  expect(container.textContent).toBe('true')
  expect(supports).toHaveBeenCalledWith('env-b', FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY)
  act(() => root.unmount())
})

it("does not lend a previous owner's answer to a host whose probe is still open", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  setLocalRuntimeCapabilitiesForTests([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
  supports.mockImplementation((environmentId: string) =>
    environmentId === 'env-remote' ? Promise.resolve(true) : never()
  )
  const container = document.createElement('div')
  const root = createRoot(container)

  await act(async () => root.render(<Probe target={REMOTE} />))
  await act(async () => {})
  expect(container.textContent).toBe('true')

  await act(async () => root.render(<Probe target={ENV_B} />))
  await act(async () => {})
  expect(container.textContent).toBe('null')
  act(() => root.unmount())
})

it('ignores a probe that answers after this reader returns to the same host', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  setLocalRuntimeCapabilitiesForTests([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
  const firstVisit = pendingProbe()
  const otherHost = pendingProbe()
  const returnVisit = pendingProbe()
  supports
    .mockReturnValueOnce(firstVisit.promise)
    .mockReturnValueOnce(otherHost.promise)
    .mockReturnValue(returnVisit.promise)
  const container = document.createElement('div')
  const root = createRoot(container)

  await act(async () => root.render(<Probe target={REMOTE} />))
  await act(async () => root.render(<Probe target={ENV_B} />))
  await act(async () => root.render(<Probe target={REMOTE} />))

  await act(async () => {
    returnVisit.resolve(true)
  })
  expect(container.textContent).toBe('true')

  // Why: the first visit's effect is gone, so its late answer must not replace the live one.
  await act(async () => {
    firstVisit.resolve(false)
  })
  expect(container.textContent).toBe('true')
  act(() => root.unmount())
})

it('does not probe this computer for a remote host', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  setLocalRuntimeCapabilitiesForTests(null)
  const getStatus = vi.fn().mockReturnValue(never())
  Object.assign(window, { api: { runtime: { getStatus } } })
  const container = document.createElement('div')
  const root = createRoot(container)

  await act(async () => root.render(<Probe target={REMOTE} />))
  await act(async () => {})

  expect(getStatus).not.toHaveBeenCalled()
  act(() => root.unmount())
})

it('reads the local answer again after a detour through a remote owner', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  setLocalRuntimeCapabilitiesForTests([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
  const getStatus = vi.fn().mockReturnValue(never())
  Object.assign(window, { api: { runtime: { getStatus } } })
  const seen: (boolean | null)[] = []
  function Recording({ target }: { target: RuntimeClientTarget }): React.JSX.Element {
    const supported = useForgeInboxArchiveSupport(target)
    seen.push(supported)
    return <span>{String(supported)}</span>
  }
  const root = createRoot(document.createElement('div'))

  await act(async () => root.render(<Recording target={LOCAL} />))
  expect(seen.at(-1)).toBe(true)
  await act(async () => root.render(<Recording target={REMOTE} />))

  // The host stopped advertising archive while this client browsed another owner.
  setLocalRuntimeCapabilitiesForTests(null)
  const firstRenderBack = seen.length
  act(() => root.render(<Recording target={LOCAL} />))

  expect(seen[firstRenderBack]).toBeNull()
  act(() => root.unmount())
})

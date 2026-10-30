// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { FORGE_INBOX_RUNTIME_CAPABILITY } from '../../../../shared/forge-inbox-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const probes = vi.hoisted(() => ({ supports: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: probes.supports
}))

vi.mock('@/components/ui/select', async () => {
  const React = await import('react')
  const SelectContext = React.createContext<{ onValueChange?: (value: string) => void }>({})

  return {
    Select: ({
      value,
      onValueChange,
      children
    }: {
      value: string
      onValueChange: (value: string) => void
      children: React.ReactNode
    }) => {
      const contextValue = React.useMemo(() => ({ onValueChange }), [onValueChange])
      return (
        <SelectContext.Provider value={contextValue}>
          <div data-slot="select" data-value={value}>
            {children}
          </div>
        </SelectContext.Provider>
      )
    },
    SelectTrigger: ({ children, ...props }: React.ComponentProps<'button'>) => (
      <button type="button" data-slot="select-trigger" {...props}>
        {children}
      </button>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div data-slot="select-content">{children}</div>
    ),
    SelectItem: ({
      value,
      disabled,
      children
    }: {
      value: string
      disabled?: boolean
      children: React.ReactNode
    }) => {
      const { onValueChange } = React.useContext(SelectContext)
      return (
        <button
          type="button"
          data-slot="select-item"
          data-value={value}
          disabled={disabled}
          onClick={() => onValueChange?.(value)}
        >
          {children}
        </button>
      )
    }
  }
})

import { ForgeInboxOwnerSelector } from './ForgeInboxOwnerSelector'

const LOCAL: RuntimeClientTarget = { kind: 'local' }

function environment(id: string, name: string): PublicKnownRuntimeEnvironment {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [
      { id: `ws-${id}`, kind: 'websocket', label: 'WebSocket', endpoint: `ws://${id}.test:6768` }
    ],
    preferredEndpointId: `ws-${id}`
  }
}

/** A WSL host has its own Settings surface, so `isListedRemoteServer` excludes it. */
function wslEnvironment(id: string, name: string): PublicKnownRuntimeEnvironment {
  return {
    ...environment(id, name),
    orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 51_700, remotePort: 6768 }
  }
}

describe('ForgeInboxOwnerSelector', () => {
  let container: HTMLDivElement
  let root: Root

  function optionNamed(text: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>('[data-slot="select-item"]')].find(
      (item) => item.textContent?.includes(text)
    )
  }

  async function render(
    target: RuntimeClientTarget,
    environments: readonly PublicKnownRuntimeEnvironment[],
    onChange: (target: RuntimeClientTarget) => void
  ): Promise<void> {
    await act(async () => {
      root.render(
        <ForgeInboxOwnerSelector target={target} environments={environments} onChange={onChange} />
      )
    })
    await act(async () => {})
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    probes.supports.mockReset().mockReturnValue(new Promise(() => undefined))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows a saved host that cannot archive as unavailable and keeps it unselectable', async () => {
    probes.supports.mockImplementation((environmentId: string) =>
      Promise.resolve(environmentId !== 'env-b')
    )
    const onChange = vi.fn()
    await render(LOCAL, [environment('env-b', 'Node B')], onChange)

    const option = optionNamed('Node B')
    expect(option).toBeDefined()
    expect(option?.textContent).toContain('unavailable')
    expect(option?.disabled).toBe(true)
    act(() => option?.click())
    expect(onChange).not.toHaveBeenCalled()
    expect(probes.supports).toHaveBeenCalledWith('env-b', FORGE_INBOX_RUNTIME_CAPABILITY)
  })

  it('shows a host whose probe is still pending as checking, not unsupported', async () => {
    await render(LOCAL, [environment('env-c', 'Node C')], vi.fn())

    const option = optionNamed('Node C')
    expect(option).toBeDefined()
    expect(option?.textContent).toContain('checking')
    expect(option?.textContent).not.toContain('unavailable')
  })

  it('reports the chosen host as an environment target', async () => {
    probes.supports.mockResolvedValue(true)
    const onChange = vi.fn()
    await render(LOCAL, [environment('env-b', 'Node B')], onChange)

    const option = optionNamed('Node B')
    expect(option?.disabled).not.toBe(true)
    act(() => option?.click())

    expect(onChange).toHaveBeenCalledWith({ kind: 'environment', environmentId: 'env-b' })
    // Why: the local owner must not gain a placeholder row for a "null" environment.
    expect(container.querySelectorAll('[data-slot="select-item"]')).toHaveLength(2)
  })

  it('names a selected owner that Settings does not list, instead of going blank', async () => {
    probes.supports.mockResolvedValue(true)
    await render(
      { kind: 'environment', environmentId: 'env-wsl' },
      [wslEnvironment('env-wsl', 'Ubuntu')],
      vi.fn()
    )

    expect(optionNamed('Ubuntu')).toBeDefined()
    expect(
      container.querySelectorAll('[data-slot="select-item"][data-value="environment:env-wsl"]')
    ).toHaveLength(1)
  })

  it('names the selected owner when Settings has not listed it at all', async () => {
    await render({ kind: 'environment', environmentId: 'env-pending' }, [], vi.fn())

    const option = container.querySelector<HTMLButtonElement>(
      '[data-slot="select-item"][data-value="environment:env-pending"]'
    )
    expect(option).not.toBeNull()
    expect(option?.textContent).toContain('env-pending')
    expect(option?.textContent).toContain('unavailable')
  })

  it('does not offer an unselected host that Settings does not list', async () => {
    probes.supports.mockResolvedValue(true)
    await render(LOCAL, [wslEnvironment('env-wsl', 'Ubuntu')], vi.fn())

    expect(optionNamed('Ubuntu')).toBeUndefined()
  })
})

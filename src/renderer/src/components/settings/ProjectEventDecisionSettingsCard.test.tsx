// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { ProjectEventDecisionSettingsCard } from './ProjectEventDecisionSettingsCard'

const fake = vi.hoisted(() => ({
  call: vi.fn(),
  probe: vi.fn(),
  supports: vi.fn(),
  status: vi.fn(),
  success: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: fake.supports
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: async () => ['project-events.decision-settings.v1']
}))
vi.mock('@/runtime/forge-inbox-client', () => ({ readForgeInboxStatus: fake.status }))
vi.mock('@/runtime/project-event-decision-settings-client', () => ({
  callProjectEventDecisionSettings: fake.call,
  testProjectEventDecisionConnection: fake.probe
}))
vi.mock('sonner', () => ({ toast: { success: fake.success } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('./integration-card-presentation', () => ({ useIntegrationCardShellClass: () => 'card' }))

const KEY = 'decision-key-CANARY'

function management(settings: Record<string, unknown> = {}, protection = 'available') {
  return {
    ownerHostId: 'owner',
    settings: {
      provider: 'jev',
      model: '',
      baseUrl: '',
      apiKeysSaved: { jev: true, laya: false },
      ...settings
    },
    protection
  }
}

function pane(id: string | null, available = true) {
  const target: RuntimeClientTarget =
    id === null ? { kind: 'local' } : { kind: 'environment', environmentId: id }
  return (
    <ProjectEventDecisionSettingsCard hostScope={{ target, available }} runtimeEnvironments={[]} />
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  fake.supports.mockResolvedValue(true)
  fake.status.mockResolvedValue({ ownerHostId: 'owner', available: true, phase: 'running' })
  fake.call.mockResolvedValue(management())
  fake.probe.mockResolvedValue({
    ok: true,
    provider: 'jev',
    model: 'jev-latest',
    usedDefaultModel: true
  })
})
afterEach(cleanup)

it('reads and saves settings on the selected host with its owner id', async () => {
  render(pane('server-a'))
  await act(async () => {})
  expect(screen.getByText('Quick decisions for project event agents on server-a')).toBeTruthy()
  expect(screen.getByText(/sent to TypeSafe/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'small' } })
  await act(async () => {})
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Save model settings' }))
  )
  expect(fake.call.mock.calls.map(([, action]) => action)).toEqual(['getSettings', 'saveSettings'])
  expect(fake.call.mock.calls[1]).toEqual([
    { kind: 'environment', environmentId: 'server-a' },
    'saveSettings',
    { ownerHostId: 'owner', settings: { provider: 'jev', model: 'small', baseUrl: '' } }
  ])
  expect(fake.success).toHaveBeenCalled()
})

it('drops a late read from the previous host', async () => {
  let resolveA: (result: unknown) => void = () => {}
  fake.call.mockImplementation((target: RuntimeClientTarget) =>
    target.kind === 'environment' && target.environmentId === 'server-a'
      ? new Promise((resolve) => {
          resolveA = resolve
        })
      : Promise.resolve(management({ model: 'from-b' }))
  )
  const view = render(pane('server-a'))
  await act(async () => {})
  await act(async () => view.rerender(pane('server-b')))
  await act(async () => resolveA(management({ model: 'from-a' })))
  expect(screen.getByLabelText('Model')).toHaveProperty('value', 'from-b')
})

it('saves and clears the key without ever showing a saved key', async () => {
  fake.call.mockResolvedValueOnce(management({ apiKeysSaved: { jev: false, laya: false } }))
  fake.call.mockResolvedValueOnce(management({ apiKeysSaved: { jev: true, laya: false } }))
  fake.call.mockResolvedValueOnce(management({ apiKeysSaved: { jev: false, laya: false } }))
  render(pane(null))
  await act(async () => {})
  expect(screen.getByText(/Jev requires one/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: KEY } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save key' })))
  expect(fake.call.mock.calls[1]).toEqual([
    { kind: 'local' },
    'saveApiKey',
    { ownerHostId: 'owner', provider: 'jev', apiKey: KEY }
  ])
  expect(screen.getByLabelText('API key')).toHaveProperty('value', '')
  expect(screen.getByText(/never shown again/)).toBeTruthy()
  expect(document.body.innerHTML).not.toContain(KEY)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear key' })))
  expect(fake.call.mock.calls[2]).toEqual([
    { kind: 'local' },
    'clearApiKey',
    { ownerHostId: 'owner', provider: 'jev' }
  ])
  expect(fake.success).toHaveBeenCalledTimes(2)
})

it('keeps unsaved model edits when only the key is saved', async () => {
  fake.call.mockResolvedValueOnce(management({ apiKeysSaved: { jev: false, laya: false } }))
  fake.call.mockResolvedValueOnce(management({ apiKeysSaved: { jev: true, laya: false } }))
  render(pane(null))
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'small' } })
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: KEY } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save key' })))
  expect(screen.getByLabelText('Model')).toHaveProperty('value', 'small')
  expect(screen.getByText(/Save your changes before testing/)).toBeTruthy()
})

it('refuses key entry when the host cannot seal credentials', async () => {
  fake.call.mockResolvedValue(
    management({ apiKeysSaved: { jev: false, laya: false } }, 'unavailable')
  )
  render(pane(null))
  await act(async () => {})
  expect(screen.getByText(/cannot seal credentials/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: KEY } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save key' })))
  expect(fake.call.mock.calls.map(([, action]) => action)).toEqual(['getSettings'])
})

it('reports key state for the selected provider, not for the other one', async () => {
  fake.call.mockResolvedValue(
    management({
      provider: 'laya',
      baseUrl: 'https://laya.example/',
      apiKeysSaved: { jev: true, laya: false }
    })
  )
  render(pane(null))
  await act(async () => {})
  expect(screen.getByText(/Add one only if your Laya deployment/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Clear key' })).toBeNull()
})

it('saves the key for the provider shown in the form', async () => {
  const laya = {
    provider: 'laya',
    baseUrl: 'https://laya.example/',
    apiKeysSaved: { jev: true, laya: false }
  }
  fake.call.mockResolvedValueOnce(management(laya))
  fake.call.mockResolvedValueOnce(management({ ...laya, apiKeysSaved: { jev: true, laya: true } }))
  render(pane(null))
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: KEY } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save key' })))
  expect(fake.call.mock.calls[1]).toEqual([
    { kind: 'local' },
    'saveApiKey',
    { ownerHostId: 'owner', provider: 'laya', apiKey: KEY }
  ])
})

it('still offers Clear for a stored key this host cannot decrypt', async () => {
  fake.call.mockResolvedValue(
    management({
      apiKeysSaved: { jev: false, laya: false },
      apiKeysSealed: { jev: true, laya: false }
    })
  )
  render(pane(null))
  await act(async () => {})
  expect(screen.getByText(/cannot be read here/)).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear key' })))
  expect(fake.call.mock.calls.map(([, action]) => action)).toEqual(['getSettings', 'clearApiKey'])
})

it('does not carry a typed key into the other provider slot', async () => {
  render(pane(null))
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: KEY } })
  await act(async () => {})
  fireEvent.click(screen.getByLabelText('Provider'))
  fireEvent.click(screen.getByRole('option', { name: 'Laya' }))
  await act(async () => {})
  expect(screen.getByLabelText('API key')).toHaveProperty('value', '')
  expect(screen.getByRole('button', { name: 'Save key' })).toHaveProperty('disabled', true)
})

it('still allows clearing a saved key when the host cannot seal credentials', async () => {
  fake.call.mockResolvedValue(
    management({ apiKeysSaved: { jev: true, laya: false } }, 'unavailable')
  )
  render(pane(null))
  await act(async () => {})
  expect(screen.getByRole('button', { name: 'Save key' })).toHaveProperty('disabled', true)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear key' })))
  expect(fake.call.mock.calls.map(([, action]) => action)).toEqual(['getSettings', 'clearApiKey'])
})

it('tests the saved settings once and reports the result without the key', async () => {
  render(pane(null))
  await act(async () => {})
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Test connection' })))
  expect(fake.probe.mock.calls).toEqual([[{ kind: 'local' }, { ownerHostId: 'owner' }]])
  expect(screen.getByText(/Connected\. Jev answered with model jev-latest/)).toBeTruthy()
  expect(screen.getByText(/provider default was used/)).toBeTruthy()
  expect(document.body.innerHTML).not.toContain(KEY)
})

it('maps a rejected key to actionable text', async () => {
  fake.probe.mockResolvedValue({ ok: false, code: 'unauthorized' })
  render(pane(null))
  await act(async () => {})
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Test connection' })))
  expect(screen.getByRole('status').textContent).toMatch(/rejected the saved API key/)
})

it('will not test unsaved edits', async () => {
  render(pane(null))
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'small' } })
  await act(async () => {})
  expect(screen.getByRole('button', { name: 'Test connection' })).toHaveProperty('disabled', true)
  expect(screen.getByText(/Save your changes before testing/)).toBeTruthy()
})

it('will not test while a new key is still unsaved', async () => {
  render(pane(null))
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: KEY } })
  await act(async () => {})
  expect(screen.getByRole('button', { name: 'Test connection' })).toHaveProperty('disabled', true)
  expect(screen.getByText(/Save your changes before testing/)).toBeTruthy()
})

it('says so instead of offering a form when the host is unsupported', async () => {
  fake.supports.mockResolvedValue(false)
  render(pane('server-a'))
  await act(async () => {})
  expect(screen.getByText(/does not support event decision settings/)).toBeTruthy()
  expect(screen.queryByLabelText('Model')).toBeNull()
  expect(fake.call).not.toHaveBeenCalled()
})

it('blames the stopped service, not the host, when only the service is detached', async () => {
  fake.supports.mockResolvedValue(false)
  fake.status.mockResolvedValue({ available: false, phase: 'stopped' })
  render(pane('server-a'))
  await act(async () => {})
  expect(screen.getByText(/Project events are not running on this host/)).toBeTruthy()
  expect(screen.queryByText(/does not support event decision settings/)).toBeNull()
  expect(fake.call).not.toHaveBeenCalled()
})

it('still names the host unsupported when its status cannot be read at all', async () => {
  fake.supports.mockResolvedValue(false)
  fake.status.mockRejectedValue(new Error('status-unavailable'))
  render(pane('server-a'))
  await act(async () => {})
  expect(screen.getByText(/does not support event decision settings/)).toBeTruthy()
  expect(fake.call).not.toHaveBeenCalled()
})

it('treats an unreadable status as no proven owner instead of a generic failure', async () => {
  fake.status.mockResolvedValue('not-a-status')
  render(pane('server-a'))
  await act(async () => {})
  expect(screen.getByText(/Project events are not running on this host/)).toBeTruthy()
  expect(screen.queryByText(/Could not complete the request/)).toBeNull()
  expect(fake.call).not.toHaveBeenCalled()
})

// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS } from '../../../../shared/project-event-receiver-settings'
import { PROJECT_EVENT_RECEIVER_LISTENER_ERROR_CODES } from '../../../../shared/project-event-receiver-listener-error-codes'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ForgeInboxStatus } from '../../../../shared/forge-inbox-rpc-types'
import { WebhookIntegrationCard } from './WebhookIntegrationCard'

const fake = vi.hoisted(() => ({
  rpc: vi.fn(),
  supports: vi.fn(),
  status: vi.fn(),
  retry: vi.fn(),
  local: vi.fn(),
  success: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: fake.rpc,
  runtimeEnvironmentSupportsCapability: fake.supports
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: async () => ['project-event-receiver.v1']
}))
vi.mock('@/runtime/forge-inbox-client', () => ({
  readForgeInboxStatus: fake.status,
  retryForgeInboxReceiver: fake.retry
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
const receiver = {
  ...DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS,
  externalBaseUrl: 'https://events.example.test'
}
const localSettings = getDefaultSettings('/synthetic')
function pane(id: string | null, available = true) {
  const target: RuntimeClientTarget =
    id === null ? { kind: 'local' } : { kind: 'environment', environmentId: id }
  return (
    <WebhookIntegrationCard
      hostScope={{ target, available }}
      runtimeEnvironments={[]}
      settings={localSettings}
      updateSettings={fake.local}
    />
  )
}
function status(listening = false, error: string | null = null): ForgeInboxStatus {
  return {
    ownerHostId: 'owner',
    available: true,
    phase: 'running',
    running: true,
    dormant: false,
    work: { pending: 0, needsAuth: 0, nextAttemptAtMs: null, draining: false },
    listener: {
      enabled: listening || error !== null,
      listening,
      port: listening ? 8123 : null,
      error
    }
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  fake.supports.mockResolvedValue(true)
  fake.rpc.mockResolvedValue({ settings: { projectEventReceiver: receiver } })
  fake.status.mockResolvedValue(status())
  fake.retry.mockResolvedValue(status())
  fake.local.mockResolvedValue(undefined)
})
afterEach(cleanup)

it('reads, writes and refreshes status only on the selected remote host', async () => {
  render(pane('server-a'))
  await act(async () => {})
  expect(screen.getByText('Event receiver on server-a')).toBeTruthy()
  expect(screen.getByText('Disabled — not receiving')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Exact listen port'), { target: { value: '8123' } })
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Save Webhook settings' }))
  )
  expect(fake.local).not.toHaveBeenCalled()
  expect(fake.rpc.mock.calls.map(([target, method]) => [target, method])).toEqual([
    [{ kind: 'environment', environmentId: 'server-a' }, 'settings.get'],
    [{ kind: 'environment', environmentId: 'server-a' }, 'settings.update']
  ])
  expect(fake.rpc.mock.calls[1]?.[2]).toEqual({ projectEventReceiver: { ...receiver, port: 8123 } })
  expect(fake.status.mock.calls.every(([target]) => target.environmentId === 'server-a')).toBe(true)
})

it('drops late A reads after switching to B', async () => {
  let resolveA: (result: unknown) => void = () => {}
  fake.rpc.mockImplementation((target: RuntimeClientTarget) =>
    target.kind === 'environment' && target.environmentId === 'server-a'
      ? new Promise((resolve) => {
          resolveA = resolve
        })
      : Promise.resolve({ settings: { projectEventReceiver: { ...receiver, port: 9002 } } })
  )
  const view = render(pane('server-a'))
  await act(async () => {})
  await act(async () => view.rerender(pane('server-b')))
  await act(async () =>
    resolveA({ settings: { projectEventReceiver: { ...receiver, port: 9001 } } })
  )
  expect(screen.getByLabelText('Exact listen port')).toHaveProperty('value', '9002')
  expect(screen.getByText('Event receiver on server-b')).toBeTruthy()
})

it('does not publish stale save success or overwrite B with an in-flight A write', async () => {
  let complete: (result: unknown) => void = () => {}
  fake.rpc.mockImplementation((_target: RuntimeClientTarget, method: string) =>
    method === 'settings.update'
      ? new Promise((resolve) => {
          complete = resolve
        })
      : Promise.resolve({ settings: { projectEventReceiver: receiver } })
  )
  const view = render(pane('server-a'))
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('Exact listen port'), { target: { value: '8123' } })
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Save Webhook settings' }))
  )
  await act(async () => view.rerender(pane('server-b')))
  await act(async () =>
    complete({ settings: { projectEventReceiver: { ...receiver, port: 8123 } } })
  )
  expect(screen.getByLabelText('Exact listen port')).toHaveProperty('value', String(receiver.port))
  expect(fake.success).not.toHaveBeenCalled()
  expect(fake.local).not.toHaveBeenCalled()
})

it('does not fall back locally for unavailable, unsupported or missing remote settings', async () => {
  const view = render(pane('gone', false))
  await act(async () => {})
  expect(fake.rpc).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('Exact listen port')).toBeNull()
  fake.supports.mockResolvedValue(false)
  await act(async () => view.rerender(pane('old')))
  expect(screen.getByRole('alert').textContent).toContain('does not support')
  expect(fake.rpc).not.toHaveBeenCalled()
  fake.supports.mockResolvedValue(true)
  fake.rpc.mockResolvedValue({ settings: {} })
  await act(async () => view.rerender(pane('missing')))
  expect(screen.getByRole('alert').textContent).toContain('did not return')
  expect(screen.queryByLabelText('Exact listen port')).toBeNull()
  expect(fake.local).not.toHaveBeenCalled()
})

it('keeps failed save errors visible without a success confirmation', async () => {
  render(pane(null))
  await act(async () => {})
  fake.local.mockRejectedValue(new Error('disk full'))
  fireEvent.change(screen.getByLabelText('Exact listen port'), { target: { value: '8123' } })
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Save Webhook settings' }))
  )
  const alert = screen.getByRole('alert').textContent
  expect(alert).toBe(
    'Could not complete the request. Retry; if it keeps failing, check the connection to the host.'
  )
  expect(alert).not.toContain('disk full')
  expect(fake.success).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Exact listen port')).toHaveProperty('value', '8123')
})

it('requires a valid exact port and acknowledgement for enabled external exposure', async () => {
  render(pane('server-a'))
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('Exact listen port'), { target: { value: '0' } })
  expect(screen.getByRole('button', { name: 'Save Webhook settings' })).toHaveProperty(
    'disabled',
    true
  )
  fireEvent.change(screen.getByLabelText('Exact listen port'), { target: { value: '8123' } })
  fireEvent.change(screen.getByLabelText('Listen IP address'), { target: { value: '0.0.0.0' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enable event receiver' }))
  expect(screen.getByRole('button', { name: 'Save Webhook settings' })).toHaveProperty(
    'disabled',
    true
  )
  fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }))
  expect(screen.getByRole('button', { name: 'Save Webhook settings' })).toHaveProperty(
    'disabled',
    false
  )
  expect(document.body.textContent).not.toContain('http://0.0.0.0')
})

it('reports owner bind failure, then real listening status after refresh without claiming connectivity', async () => {
  fake.status.mockResolvedValue(
    status(false, PROJECT_EVENT_RECEIVER_LISTENER_ERROR_CODES.addressInUse)
  )
  fake.retry.mockResolvedValue(status(true))
  render(pane('server-a'))
  await act(async () => {})
  expect(screen.getByRole('alert').textContent).toBe(
    'The port is already in use. Stop the other process or choose another port.'
  )
  expect(screen.getByText('Unavailable or failed')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh / retry' })))
  expect(fake.retry).toHaveBeenCalled()
  expect(screen.getByText('Listening on port 8123')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText(/Listening does not verify GitLab connectivity/)).toBeTruthy()
})

it('rejects an old A save completion even after navigating A → B → A', async () => {
  let complete: (result: unknown) => void = () => {}
  fake.rpc.mockImplementation((_target: RuntimeClientTarget, method: string) =>
    method === 'settings.update'
      ? new Promise((resolve) => {
          complete = resolve
        })
      : Promise.resolve({ settings: { projectEventReceiver: receiver } })
  )
  const view = render(pane('server-a'))
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('Exact listen port'), { target: { value: '8123' } })
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Save Webhook settings' }))
  )
  await act(async () => view.rerender(pane('server-b')))
  await act(async () => view.rerender(pane('server-a')))
  fireEvent.change(screen.getByLabelText('Exact listen port'), { target: { value: '9003' } })
  await act(async () =>
    complete({ settings: { projectEventReceiver: { ...receiver, port: 8123 } } })
  )
  expect(screen.getByLabelText('Exact listen port')).toHaveProperty('value', '9003')
  expect(fake.success).not.toHaveBeenCalled()
})

it('distinguishes a failed capability probe from unsupported and recovers on retry', async () => {
  fake.supports.mockRejectedValue(new Error('SSH connection refused'))
  render(pane('server-a'))
  await act(async () => {})
  const alert = screen.getByRole('alert').textContent
  expect(alert).toBe(
    'Could not complete the request. Retry; if it keeps failing, check the connection to the host.'
  )
  expect(alert).not.toContain('SSH connection refused')
  expect(screen.queryByLabelText('Exact listen port')).toBeNull()
  expect(fake.rpc).not.toHaveBeenCalled()
  fake.supports.mockResolvedValue(true)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh / retry' })))
  expect(screen.getByLabelText('Exact listen port')).toHaveProperty('value', String(receiver.port))
  expect(screen.queryByRole('alert')).toBeNull()
})

it('reconciles the receiver listener when the user refreshes', async () => {
  fake.status.mockResolvedValue(
    status(false, PROJECT_EVENT_RECEIVER_LISTENER_ERROR_CODES.addressInUse)
  )
  fake.retry.mockResolvedValue(status(true))
  render(pane('server-a'))
  await act(async () => {})
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh / retry' })))
  expect(fake.retry).toHaveBeenCalledWith({ kind: 'environment', environmentId: 'server-a' })
  expect(screen.getByText('Listening on port 8123')).toBeTruthy()
})

it('renders the post-save listener status the host returned from retry', async () => {
  const saved = { ...receiver, enabled: true, port: 8123 }
  fake.rpc.mockImplementation((_target: RuntimeClientTarget, method: string) =>
    Promise.resolve({
      settings: { projectEventReceiver: method === 'settings.update' ? saved : receiver }
    })
  )
  fake.retry.mockResolvedValue(status(true))
  render(pane('server-a'))
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('Exact listen port'), { target: { value: '8123' } })
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Save Webhook settings' }))
  )
  expect(fake.retry).toHaveBeenCalledWith({ kind: 'environment', environmentId: 'server-a' })
  expect(fake.status).toHaveBeenCalledTimes(1)
  expect(screen.getByText('Listening on port 8123')).toBeTruthy()
  expect(fake.success).toHaveBeenCalled()
})

it('shows an applying label while saving instead of status unknown', async () => {
  let resolveRetry: (value: ForgeInboxStatus) => void = () => {}
  fake.rpc.mockImplementation((_target: RuntimeClientTarget, method: string) =>
    Promise.resolve({
      settings: {
        projectEventReceiver: method === 'settings.update' ? { ...receiver, port: 8123 } : receiver
      }
    })
  )
  fake.retry.mockImplementation(
    () =>
      new Promise<ForgeInboxStatus>((resolve) => {
        resolveRetry = resolve
      })
  )
  fake.status.mockResolvedValue(status(true))
  render(pane('server-a'))
  await act(async () => {})
  expect(screen.getByText('Listening on port 8123')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Exact listen port'), { target: { value: '8123' } })
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Save Webhook settings' }))
  )
  expect(screen.getByText('Applying changes…')).toBeTruthy()
  expect(screen.queryByText('Status unknown')).toBeNull()
  await act(async () => resolveRetry(status(true)))
  expect(screen.getByText('Listening on port 8123')).toBeTruthy()
})

it('disables refresh while the form has unsaved edits', async () => {
  render(pane('server-a'))
  await act(async () => {})
  const refresh = screen.getByRole('button', { name: 'Refresh / retry' })
  expect(refresh).toHaveProperty('disabled', false)
  fireEvent.change(screen.getByLabelText('Exact listen port'), { target: { value: '9000' } })
  expect(refresh).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByLabelText('Exact listen port'), {
    target: { value: String(receiver.port) }
  })
  expect(refresh).toHaveProperty('disabled', false)
})

it('keeps a committed save successful but shows a localized host failure when retry fails', async () => {
  fake.rpc.mockImplementation((_target: RuntimeClientTarget, method: string) =>
    Promise.resolve({
      settings: {
        projectEventReceiver: method === 'settings.update' ? { ...receiver, port: 8123 } : receiver
      }
    })
  )
  fake.retry.mockRejectedValue(
    new Error('forgeInbox.retryReceiver failed: forge_inbox_unavailable')
  )
  render(pane('server-a'))
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('Exact listen port'), { target: { value: '8123' } })
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Save Webhook settings' }))
  )
  expect(fake.success).toHaveBeenCalled()
  const alert = screen.getByRole('alert')
  expect(alert.textContent).toBe(
    'Could not complete the request. Retry; if it keeps failing, check the connection to the host.'
  )
  expect(alert.textContent).not.toContain('forge_inbox_unavailable')
  expect(screen.getByLabelText('Exact listen port')).toHaveProperty('value', '8123')
})

it('does not show raw backend text when reading settings fails', async () => {
  fake.rpc.mockRejectedValue(new Error('runtime_unavailable'))
  render(pane('server-a'))
  await act(async () => {})
  const alert = screen.getByRole('alert')
  expect(alert.textContent).toBe(
    'Could not complete the request. Retry; if it keeps failing, check the connection to the host.'
  )
  expect(alert.textContent).not.toContain('runtime_unavailable')
})

it('still shows the specific unsupported-host message', async () => {
  fake.supports.mockResolvedValue(false)
  render(pane('server-a'))
  await act(async () => {})
  expect(screen.getByRole('alert').textContent).toBe(
    'This host does not support Webhook settings. Update the host and retry.'
  )
})

it('warns when the listening receiver has no external callback address', async () => {
  const noCallback = {
    ...DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS,
    enabled: true,
    port: 8123,
    externalBaseUrl: ''
  }
  fake.rpc.mockImplementation(() =>
    Promise.resolve({ settings: { projectEventReceiver: noCallback } })
  )
  fake.status.mockResolvedValue(status(true))
  render(pane('server-a'))
  await act(async () => {})
  const label = screen.getByText(
    'Listening on port 8123, but no external callback address is configured'
  )
  expect(label.className).toContain('amber')
})

it('keeps the running status when the draft clears the persisted callback address', async () => {
  fake.rpc.mockResolvedValue({ settings: { projectEventReceiver: receiver } })
  fake.status.mockResolvedValue(status(true))
  render(pane('server-a'))
  await act(async () => {})
  expect(screen.getByText('Listening on port 8123').className).not.toContain('amber')
  fireEvent.change(screen.getByLabelText('External base URL'), { target: { value: '' } })
  expect(screen.getByText('Listening on port 8123').className).not.toContain('amber')
})

it('keeps the missing-callback warning until the persisted address is saved', async () => {
  const noCallback = {
    ...DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS,
    enabled: true,
    port: 8123,
    externalBaseUrl: ''
  }
  fake.rpc.mockResolvedValue({ settings: { projectEventReceiver: noCallback } })
  fake.status.mockResolvedValue(status(true))
  render(pane('server-a'))
  await act(async () => {})
  const warning = 'Listening on port 8123, but no external callback address is configured'
  expect(screen.getByText(warning).className).toContain('amber')
  fireEvent.change(screen.getByLabelText('External base URL'), {
    target: { value: 'https://later.example.test' }
  })
  expect(screen.getByText(warning).className).toContain('amber')
})

it('uses the attention tone for a failed listener and keeps listening neutral', async () => {
  fake.status.mockResolvedValue(
    status(false, PROJECT_EVENT_RECEIVER_LISTENER_ERROR_CODES.addressInUse)
  )
  const view = render(pane('server-a'))
  await act(async () => {})
  expect(screen.getByText('Unavailable or failed').className).toContain('amber')

  fake.retry.mockResolvedValue(status(true))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh / retry' })))
  const listening = screen.getByText('Listening on port 8123')
  expect(listening.className).not.toContain('amber')
  expect(listening.className).toContain('border-border')
  view.unmount()
})

it('localizes listener error codes instead of echoing them', async () => {
  fake.status.mockResolvedValue(
    status(false, PROJECT_EVENT_RECEIVER_LISTENER_ERROR_CODES.addressInUse)
  )
  render(pane('server-a'))
  await act(async () => {})
  const alert = screen.getByRole('alert')
  expect(alert.textContent).toBe(
    'The port is already in use. Stop the other process or choose another port.'
  )
  expect(alert.textContent).not.toContain('EADDRINUSE')
  expect(alert.textContent).not.toContain('listen-failed')
})

it('falls back to the generic message for an unknown listener code', async () => {
  fake.status.mockResolvedValue(status(false, 'brand-new-host-code'))
  render(pane('server-a'))
  await act(async () => {})
  const alert = screen.getByRole('alert')
  expect(alert.textContent).toBe('The listener failed to start.')
  expect(alert.textContent).not.toContain('brand-new-host-code')
})

it('tolerates receiver fields a newer host adds when reading remote settings', async () => {
  fake.rpc.mockImplementation((_target: RuntimeClientTarget, method: string) =>
    method === 'settings.get'
      ? Promise.resolve({ settings: { projectEventReceiver: { ...receiver, futureFlag: true } } })
      : Promise.resolve({ settings: { projectEventReceiver: receiver } })
  )
  render(pane('server-a'))
  await act(async () => {})
  expect(screen.getByLabelText('Exact listen port')).toHaveProperty('value', String(receiver.port))
  expect(screen.queryByRole('alert')).toBeNull()
})

it('allows disabling a saved receiver that failed because plaintext exposure is unacknowledged', async () => {
  fake.rpc.mockResolvedValue({
    settings: { projectEventReceiver: { ...receiver, enabled: true, bindAddress: '0.0.0.0' } }
  })
  fake.status.mockResolvedValue(
    status(false, PROJECT_EVENT_RECEIVER_LISTENER_ERROR_CODES.externalPlaintextNotAcknowledged)
  )
  render(pane('server-a'))
  await act(async () => {})
  expect(
    screen.getByRole('checkbox', { name: 'Enable event receiver' }).getAttribute('aria-checked')
  ).toBe('true')
  expect(screen.getByRole('button', { name: 'Save Webhook settings' })).toHaveProperty(
    'disabled',
    true
  )
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enable event receiver' }))
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Save Webhook settings' }))
  )
  expect(fake.rpc.mock.calls[1]?.[2]).toEqual({
    projectEventReceiver: { ...receiver, enabled: false, bindAddress: '0.0.0.0' }
  })
  expect(fake.local).not.toHaveBeenCalled()
})

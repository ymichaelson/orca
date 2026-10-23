import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FORGE_INBOX_STOP_DEADLINE_MS } from './main-process-forge-inbox-stop'
import {
  createServeDesktopActivationGate,
  type ServeDesktopActivationGate
} from './serve-desktop-activation'

const { state, foundation, runtime, i18n, launch } = vi.hoisted(() => ({
  state: {
    store: { freezeWritesAsync: vi.fn(async () => {}) },
    profileStateAdmission: initialAdmission(),
    desktopActivationGate: initialActivationGate(),
    mainProcessI18nReady: Promise.resolve(),
    runtime: initialRuntime()
  },
  foundation: vi.fn(async () => {}),
  runtime: vi.fn(async () => {}),
  i18n: vi.fn(async () => {}),
  launch: vi.fn(async () => {})
}))

function initialAdmission(): { release(): void } | undefined {
  return undefined
}

function initialRuntime(): { stopForgeInboxService: () => Promise<void> } | null {
  return null
}

function initialActivationGate(): ServeDesktopActivationGate | null {
  return null
}

vi.mock('./main-process-state', () => ({ mainProcessState: state }))
vi.mock('./main-process-ready-foundation', () => ({ initializeReadyFoundation: foundation }))
vi.mock('./main-process-ready-runtime', () => ({ initializeReadyRuntimeServices: runtime }))
vi.mock('./main-process-i18n-menu', () => ({ initializeMainProcessI18nAndMenu: i18n }))
vi.mock('./main-process-runtime-launch', () => ({ initializeMainProcessRuntimeLaunch: launch }))

import { initializeMainProcessReady } from './main-process-ready'

const options = {
  openMainWindow: (): never => {
    throw new Error('Unexpected window creation in startup cleanup test')
  },
  handleMacAppActivation: () => {}
}

beforeEach(() => {
  vi.clearAllMocks()
  state.profileStateAdmission = { release: vi.fn() }
  state.desktopActivationGate = null
  state.runtime = null
})

describe('startup persistence lifetime', () => {
  it('disables activations before a failed launch closes its profile writer', async () => {
    const activateWindow = vi.fn()
    state.desktopActivationGate = createServeDesktopActivationGate({
      initialState: 'ready',
      activateWindow
    })
    const failure = new Error('runtime startup failed')
    launch.mockRejectedValueOnce(failure)
    let finishFreeze = (): void => {}
    state.store.freezeWritesAsync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFreeze = resolve
        })
    )
    const rejected = expect(initializeMainProcessReady(options)).rejects.toBe(failure)

    await vi.waitFor(() => expect(state.store.freezeWritesAsync).toHaveBeenCalledOnce())

    expect(state.desktopActivationGate).toBeNull()
    state.desktopActivationGate?.requestActivation()
    expect(activateWindow).not.toHaveBeenCalled()
    finishFreeze()
    await rejected
  })

  it('awaits writer release after a later startup phase fails', async () => {
    const failure = new Error('runtime startup failed')
    const admission = state.profileStateAdmission
    runtime.mockRejectedValueOnce(failure)
    let release = () => {}
    state.store.freezeWritesAsync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const ready = initializeMainProcessReady(options)
    const rejected = expect(ready).rejects.toBe(failure)
    await vi.waitFor(() => expect(state.store.freezeWritesAsync).toHaveBeenCalledOnce())
    expect(admission?.release).not.toHaveBeenCalled()
    release()
    await rejected
    expect(admission?.release).toHaveBeenCalledOnce()
    expect(state.profileStateAdmission).toBeUndefined()
    expect(launch).not.toHaveBeenCalled()
  })

  it('joins concurrent startup branches before closing their Store', async () => {
    const failure = new Error('translations failed')
    i18n.mockRejectedValueOnce(failure)
    let release = () => {}
    launch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const ready = initializeMainProcessReady(options)
    const rejected = expect(ready).rejects.toBe(failure)
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
    expect(state.store.freezeWritesAsync).not.toHaveBeenCalled()
    release()
    await rejected
    expect(state.store.freezeWritesAsync).toHaveBeenCalledOnce()
  })

  it('keeps the original startup failure when cleanup also fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('foundation failed')
    foundation.mockRejectedValueOnce(failure)
    state.store.freezeWritesAsync.mockRejectedValueOnce(new Error('close failed'))
    try {
      await expect(initializeMainProcessReady(options)).rejects.toBe(failure)
      expect(log).toHaveBeenCalledOnce()
      expect(state.profileStateAdmission?.release).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it('stops the forge inbox service before the writer closes and admission is released', async () => {
    const failure = new Error('runtime startup failed')
    const admission = state.profileStateAdmission
    const forgeStop = Promise.withResolvers<void>()
    state.runtime = { stopForgeInboxService: vi.fn(() => forgeStop.promise) }
    launch.mockRejectedValueOnce(failure)
    const rejected = expect(initializeMainProcessReady(options)).rejects.toBe(failure)

    await vi.waitFor(() => expect(state.runtime?.stopForgeInboxService).toHaveBeenCalledOnce())
    expect(state.store.freezeWritesAsync).not.toHaveBeenCalled()
    expect(admission?.release).not.toHaveBeenCalled()

    forgeStop.resolve()
    await rejected
    expect(state.store.freezeWritesAsync).toHaveBeenCalledOnce()
    expect(admission?.release).toHaveBeenCalledOnce()
  })

  it('still closes the writer and keeps the original failure when the forge inbox stop fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('runtime startup failed')
    const admission = state.profileStateAdmission
    state.runtime = { stopForgeInboxService: vi.fn(() => Promise.reject(new Error('stop failed'))) }
    launch.mockRejectedValueOnce(failure)
    try {
      await expect(initializeMainProcessReady(options)).rejects.toBe(failure)
      expect(state.store.freezeWritesAsync).toHaveBeenCalledOnce()
      expect(admission?.release).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it('closes the writer after the capped wait when the forge inbox stop never settles', async () => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('runtime startup failed')
    const admission = state.profileStateAdmission
    state.runtime = { stopForgeInboxService: vi.fn(() => new Promise<void>(() => {})) }
    launch.mockRejectedValueOnce(failure)
    try {
      const rejected = expect(initializeMainProcessReady(options)).rejects.toBe(failure)
      await vi.advanceTimersByTimeAsync(FORGE_INBOX_STOP_DEADLINE_MS - 1)
      expect(state.store.freezeWritesAsync).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await rejected
      expect(state.store.freezeWritesAsync).toHaveBeenCalledOnce()
      expect(admission?.release).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledWith('[forge-inbox] stop timed out')
    } finally {
      vi.useRealTimers()
      log.mockRestore()
    }
  })
})

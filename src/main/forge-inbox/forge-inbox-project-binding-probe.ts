import { connect } from 'node:net'
import { normalizeProjectEventReceiverSettings } from '../../shared/project-event-receiver-settings'
import type { ProjectEventReceiverSettingsSource } from '../project-events/project-event-receiver-settings-source'
import type { ProjectBindingProbe } from './forge-inbox-project-binding-reconcile'

const PROBE_TIMEOUT_MS = 1500

function probeLoopback(address: string, port: number): Promise<{ ok: boolean; code?: string }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: { ok: boolean; code?: string }): void => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      resolve(result)
    }
    const socket = connect({ host: address, port })
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish({ ok: false, code: 'receiver-unreachable' }))
    socket.once('connect', () => finish({ ok: true }))
    socket.once('error', () => finish({ ok: false, code: 'receiver-unreachable' }))
  })
}

/** Proves the host's own receiver is accepting connections before a binding is called connected. */
export function createLoopbackProjectEventProbe(
  receiverSettings: ProjectEventReceiverSettingsSource | undefined
): ProjectBindingProbe {
  return async () => {
    const settings = normalizeProjectEventReceiverSettings(receiverSettings?.read())
    if (!settings.enabled) {
      return { ok: false, code: 'receiver-disabled' }
    }
    return probeLoopback(settings.bindAddress, settings.port)
  }
}

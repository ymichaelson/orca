import type { OrcaRuntimeService } from '../orca-runtime'
import type { ForgeChangeStream } from './forge-inbox-change-stream'

type OpenStream = { connectionKey: string; stream: ForgeChangeStream }

const openStreams = new WeakMap<OrcaRuntimeService, Map<string, OpenStream>>()

export function forgeStreamConnectionKey(connectionId: string | undefined): string {
  return connectionId ?? 'inproc'
}

export function forgeStreamIdPrefix(connectionId: string | undefined): string {
  return `forge-inbox-changes-${forgeStreamConnectionKey(connectionId)}-`
}

export function registerForgeStream(
  runtime: OrcaRuntimeService,
  subscriptionId: string,
  entry: OpenStream
): void {
  let streams = openStreams.get(runtime)
  if (!streams) {
    streams = new Map()
    openStreams.set(runtime, streams)
  }
  streams.set(subscriptionId, entry)
}

export function unregisterForgeStream(runtime: OrcaRuntimeService, subscriptionId: string): void {
  openStreams.get(runtime)?.delete(subscriptionId)
}

/** Only the connection that opened the stream can address it. */
export function findForgeStream(
  runtime: OrcaRuntimeService,
  subscriptionId: string,
  connectionId: string | undefined
): ForgeChangeStream | null {
  const entry = openStreams.get(runtime)?.get(subscriptionId)
  return entry && entry.connectionKey === forgeStreamConnectionKey(connectionId)
    ? entry.stream
    : null
}

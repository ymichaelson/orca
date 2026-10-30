import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SecretStore } from '../../../shared/secret-store'
import type { createReceiverSettingsFixture } from '../../project-events/project-event-receiver-settings-test-fixture'
import { ForgeInboxLedger } from '../../forge-inbox/forge-inbox-ledger'
import { createForgeInboxOwnerService } from '../../forge-inbox/forge-inbox-owner-service'
import {
  fakeSecretStore,
  INSTANCE_ID,
  PROJECT_ID,
  webhookConfig,
  webhookInstance
} from '../../forge-inbox/forge-inbox-webhook-test-harness'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'
import type { RpcRequest, RpcResponse } from './core'
import { RpcDispatcher } from './dispatcher'
import { isRecord } from './orchestration-session-caller-test-fixture'
import { DESKTOP_RPC_CALLER } from './rpc-caller-identity'
import { FORGE_INBOX_METHODS } from './methods/forge-inbox'

export const CANARY = 'CANARY-7f3a91'

export function recordsOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error('expected an array of records')
  }
  return value
}

export function recordOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('expected a record')
  }
  return value
}

export function errorCodeOf(response: RpcResponse): string | null {
  return response.ok ? null : response.error.code
}

export type Caller = 'cli' | 'desktop' | 'paired-a' | 'paired-b' | 'mobile' | 'unidentified'

const CALLER_OPTIONS: Record<Caller, RpcDispatchStreamingOptions | undefined> = {
  cli: undefined,
  desktop: { caller: DESKTOP_RPC_CALLER },
  'paired-a': {
    pairedDeviceId: 'device-a',
    callerScope: { kind: 'runtime-paired', grants: [] }
  },
  'paired-b': {
    pairedDeviceId: 'device-b',
    callerScope: { kind: 'runtime-paired', grants: [] }
  },
  mobile: { clientKind: 'mobile', pairedDeviceId: 'phone', callerScope: { kind: 'mobile' } },
  unidentified: { clientKind: 'runtime' }
}

export type ForgeStream = {
  /** Result frames in arrival order; error replies are kept apart. */
  frames: Record<string, unknown>[]
  errors: string[]
  done: Promise<void>
  abort: () => void
  /** Resolves once a recorded frame matches; rejects after a short real wait so a hang fails loudly. */
  waitFor: (match: (frame: Record<string, unknown>) => boolean, label: string) => Promise<void>
}

export type ForgeRpcHarness = {
  runtime: OrcaRuntimeService
  dbPath: string
  secretStore: SecretStore
  call: (
    method: string,
    params: unknown,
    caller?: Caller,
    connectionId?: string
  ) => Promise<RpcResponse>
  /** Result of a call that must succeed. */
  ok: (
    method: string,
    params: unknown,
    caller?: Caller,
    connectionId?: string
  ) => Promise<Record<string, unknown>>
  /** A real streaming dispatch whose emitted frames are recorded; closes with the harness. */
  stream: (
    method: string,
    params: unknown,
    options?: {
      caller?: Caller
      connectionId?: string
      failOnChange?: boolean
      failAfterReady?: boolean
    }
  ) => ForgeStream
  /** A second real ledger connection on the owner's file, for seeding through real ingest. */
  openLedger: (hostId: string) => ForgeInboxLedger
  /** Set only when the caller supplied one: the listener binds from these settings, not the ledger config. */
  receiverSettings?: ReturnType<typeof createReceiverSettingsFixture>
  stop: () => Promise<void>
  close: () => Promise<void>
}

export async function createForgeRpcHarness(
  options: {
    secretStore?: SecretStore
    attach?: boolean
    http?: { fetch: (url: string, init?: RequestInit) => Promise<Response> }
    receiverSettings?: ReturnType<typeof createReceiverSettingsFixture>
    ownerOptions?: Partial<Parameters<typeof createForgeInboxOwnerService>[0]>
  } = {}
): Promise<ForgeRpcHarness> {
  const root = mkdtempSync(join(tmpdir(), 'forge-rpc-'))
  const dbPath = join(root, 'forge-inbox.sqlite')
  const secretStore = options.secretStore ?? fakeSecretStore()
  const service = createForgeInboxOwnerService({
    dbPath,
    http: options.http ?? { fetch: () => Promise.reject(new Error('no network in tests')) },
    secretStore,
    ...(options.receiverSettings === undefined
      ? {}
      : { receiverSettings: options.receiverSettings }),
    ...options.ownerOptions
  })
  const runtime = new OrcaRuntimeService()
  if (options.attach !== false) {
    runtime.attachForgeInboxService(service)
    await service.start()
  }
  const dispatcher = new RpcDispatcher({ runtime, methods: FORGE_INBOX_METHODS })
  let requestId = 0
  const call: ForgeRpcHarness['call'] = (method, params, caller = 'cli', connectionId) => {
    requestId += 1
    const request: RpcRequest = { id: `r${requestId}`, authToken: 'test', method, params }
    return dispatcher.dispatch(request, { ...CALLER_OPTIONS[caller], connectionId })
  }
  const streams: ForgeStream[] = []
  const stream: ForgeRpcHarness['stream'] = (method, params, options = {}) => {
    requestId += 1
    const request: RpcRequest = { id: `r${requestId}`, authToken: 'test', method, params }
    const controller = new AbortController()
    const frames: Record<string, unknown>[] = []
    const errors: string[] = []
    const watchers = new Set<() => void>()
    const done = dispatcher.dispatchStreaming(
      request,
      (raw) => {
        const reply = recordOf(JSON.parse(raw))
        const type = reply.ok === true ? recordOf(reply.result).type : undefined
        if (options.failOnChange && type === 'change') {
          throw new Error('sink closed')
        }
        if (options.failAfterReady && frames.some((frame) => frame.type === 'ready')) {
          throw new Error('sink closed')
        }
        if (reply.ok === true) {
          frames.push(recordOf(reply.result))
        } else {
          errors.push(String(recordOf(reply.error).code))
        }
        watchers.forEach((notify) => notify())
      },
      {
        ...CALLER_OPTIONS[options.caller ?? 'cli'],
        connectionId: options.connectionId,
        signal: controller.signal
      }
    )
    const opened: ForgeStream = {
      frames,
      errors,
      done,
      abort: () => controller.abort(),
      waitFor: (match, label) =>
        new Promise<void>((resolve, reject) => {
          const check = () => {
            if (frames.some(match)) {
              watchers.delete(check)
              clearTimeout(timer)
              resolve()
            }
          }
          const timer = setTimeout(() => {
            watchers.delete(check)
            reject(new Error(`timed out waiting for ${label}: ${JSON.stringify(frames.slice(-3))}`))
          }, 3000)
          watchers.add(check)
          check()
        })
    }
    streams.push(opened)
    return opened
  }
  const ledgers: ForgeInboxLedger[] = []
  return {
    runtime,
    dbPath,
    secretStore,
    ...(options.receiverSettings === undefined
      ? {}
      : { receiverSettings: options.receiverSettings }),
    call,
    stream,
    async ok(method, params, caller, connectionId) {
      const response = await call(method, params, caller, connectionId)
      if (!response.ok || !isRecord(response.result)) {
        throw new Error(
          `${method} failed: ${response.ok ? 'non-object result' : response.error.code}`
        )
      }
      return response.result
    },
    openLedger(hostId) {
      const ledger = ForgeInboxLedger.open(dbPath, { hostId, secretStore })
      ledgers.push(ledger)
      return ledger
    },
    stop: () => service.stop(),
    async close() {
      streams.forEach((opened) => opened.abort())
      ledgers.forEach((ledger) => ledger.close())
      try {
        await service.stop()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  }
}

export function enabledConfig() {
  return webhookConfig([
    webhookInstance({
      usernames: ['me'],
      projects: [{ projectId: PROJECT_ID, repoId: 'repo-1', enabled: true }]
    })
  ])
}

export async function configure(harness: ForgeRpcHarness): Promise<string> {
  const ownerHostId = String((await harness.ok('forgeInbox.getStatus', {})).ownerHostId)
  const service = harness.runtime.forgeInboxService()
  const result = await service.updateConfig(
    service.getConfig().configRevision,
    enabledConfig(),
    ownerHostId
  )
  if (!result.ok) {
    throw new Error(`fixture config failed: ${result.reason}`)
  }
  return ownerHostId
}

export function seedItem(
  ledger: ForgeInboxLedger,
  ownerHostId: string,
  iid: number,
  payload: unknown = { category: 'review-request', completeness: { complete: true } },
  reason = 'review-request'
) {
  const ingested = ledger.ingestEvent({
    hostId: ownerHostId,
    instanceId: INSTANCE_ID,
    projectId: PROJECT_ID,
    kind: 'merge_request',
    iid,
    dedupeKey: `delivery-${iid}`,
    eventKind: 'merge_request.updated',
    payload,
    versionToken: `v${iid}`,
    sourceOrder: iid,
    title: `MR ${iid}`,
    itemState: 'opened',
    queueRun: { reason }
  })
  if (ingested.duplicate) {
    throw new Error('unexpected duplicate')
  }
  return ingested
}

import type { RemoteRuntimeSharedControlConnection } from '../../../shared/remote-runtime-shared-control-connection'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'

export async function sendRuntimeBoundRequest<TResult>(
  shared: RemoteRuntimeSharedControlConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  expectedRuntimeId: string,
  envelope?: RuntimeOrchestrationEnvelope,
  signal?: AbortSignal
): Promise<RuntimeRpcResponse<TResult> | null> {
  let statusSocket: number | undefined
  const status = await shared.request<RuntimeStatus>(
    'status.get',
    undefined,
    timeoutMs,
    undefined,
    signal,
    () => {
      statusSocket = shared.socketGeneration.peek()
    }
  )
  if (!status.ok || status.result.runtimeId !== expectedRuntimeId) {
    return null
  }
  let socketChanged = false
  try {
    return await shared.request<TResult>(method, params, timeoutMs, envelope, signal, () => {
      socketChanged = shared.socketGeneration.peek() !== statusSocket
      if (socketChanged) {
        throw new Error('Runtime connection changed before sending')
      }
    })
  } catch (error) {
    if (socketChanged) {
      return null
    }
    throw error
  }
}

import { createInterface } from 'node:readline'
import type { PipedProcessSpawner, ProcessSpec } from '@orca/process-host/process-spec'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'

export const PROTECTED_NATIVE_SESSION = '5348c19f-6a54-4c2e-9c68-9c2b1a3d4e5f'

export function objectFrame(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function drainSdkMicrotasks() {
  for (let index = 0; index < 100; index += 1) {
    await Promise.resolve()
  }
}

export function fakeProtectedSdkProcess(
  input: {
    holdInitialize?: boolean
    holdMcp?: boolean
    initialize?: Record<string, unknown>
    mcpServers?: readonly unknown[]
  } = {}
) {
  const lifecycle: { exitCode: number | null; killed: boolean; signalCode: NodeJS.Signals | null } =
    {
      exitCode: null,
      killed: false,
      signalCode: null
    }
  const child = Object.assign(createFakePipedChild(987654321), lifecycle)
  const specs: ProcessSpec[] = []
  const frames: Record<string, unknown>[] = []
  const controls: Record<string, unknown>[] = []
  const pending = new Map<string, string>()
  let finished = false
  let holdInitialize = input.holdInitialize ?? false
  let holdMcp = input.holdMcp ?? false

  function emit(frame: Record<string, unknown>) {
    if (!finished) {
      child.stdout.write(`${JSON.stringify(frame)}\n`)
    }
  }

  function answer(id: string, response: unknown) {
    queueMicrotask(() =>
      emit({
        type: 'control_response',
        response: { subtype: 'success', request_id: id, response }
      })
    )
  }

  function initializeResponse() {
    return (
      input.initialize ?? {
        commands: [{ name: 'compact', description: 'Compact context', argumentHint: '' }],
        agents: [],
        output_style: 'default',
        available_output_styles: ['default'],
        models: [{ value: 'opus', displayName: 'Opus', description: 'Fake model' }],
        account: { apiKeySource: 'ANTHROPIC_API_KEY' }
      }
    )
  }

  function respond(subtype: string, id: string) {
    if ((subtype === 'initialize' && holdInitialize) || (subtype === 'mcp_status' && holdMcp)) {
      pending.set(subtype, id)
      return
    }
    if (subtype === 'initialize') {
      answer(id, initializeResponse())
    } else if (subtype === 'mcp_status') {
      answer(id, { mcpServers: input.mcpServers ?? [] })
    } else {
      answer(id, {})
    }
  }

  const reader = createInterface({ input: child.stdin })
  reader.on('line', (line) => {
    const frame: unknown = JSON.parse(line)
    if (!objectFrame(frame)) {
      throw new Error('SDK wrote a non-object frame')
    }
    frames.push(frame)
    if (frame.type === 'control_request') {
      controls.push(frame)
      if (
        !objectFrame(frame.request) ||
        typeof frame.request.subtype !== 'string' ||
        typeof frame.request_id !== 'string'
      ) {
        throw new Error('Malformed SDK control request')
      }
      respond(frame.request.subtype, frame.request_id)
    }
  })

  function finish() {
    if (finished) {
      return
    }
    finished = true
    child.exitCode = 0
    reader.close()
    child.stdout.end()
    child.stderr.end()
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
  }

  child.stdin.once('finish', finish)
  child.kill.mockImplementation(() => {
    child.killed = true
    finish()
    return true
  })
  const spawn: PipedProcessSpawner = (spec) => {
    specs.push(spec)
    return child
  }

  return {
    child,
    specs,
    frames,
    controls,
    spawn,
    emit,
    finish,
    users: () => frames.filter((frame) => frame.type === 'user'),
    controlSubtypes: () =>
      controls.map((frame) => (objectFrame(frame.request) ? frame.request.subtype : null)),
    admitInitialize() {
      holdInitialize = false
      const id = pending.get('initialize')
      if (id) {
        pending.delete('initialize')
        respond('initialize', id)
      }
    },
    admitMcp() {
      holdMcp = false
      const id = pending.get('mcp_status')
      if (id) {
        pending.delete('mcp_status')
        respond('mcp_status', id)
      }
    }
  }
}

export function nativeArgv(spec: ProcessSpec) {
  const argv = [spec.program, ...(spec.args ?? [])]
  return spec.env?.ORCA_PROVIDER_SUPERVISOR_SPEC ? argv.slice(argv.indexOf('--') + 1) : argv
}

export function nativeEnvironment(spec: ProcessSpec): Record<string, unknown> {
  const encoded = spec.env?.ORCA_PROVIDER_SUPERVISOR_SPEC
  if (typeof encoded !== 'string') {
    return spec.env ?? {}
  }
  const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString())
  if (!objectFrame(decoded) || !objectFrame(decoded.nodeEnv)) {
    throw new Error('Missing supervisor native environment')
  }
  const env: Record<string, unknown> = { ...spec.env, ...decoded.nodeEnv }
  delete env.ORCA_PROVIDER_SUPERVISOR_SPEC
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

export function protectedUserMessage(text: string, uuid: string) {
  return {
    type: 'user',
    session_id: PROTECTED_NATIVE_SESSION,
    parent_tool_use_id: null,
    uuid,
    message: { role: 'user', content: [{ type: 'text', text }] }
  }
}

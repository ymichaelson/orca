import type { SecretStore } from '../../shared/secret-store'
import type { GlabExecOptions } from '../git/command-runner/glab-exec-file'

export type Exec = (
  args: string[],
  options?: GlabExecOptions
) => Promise<{ stdout: string; stderr: string }>

export type FakeHook = { id: number; project_id: number; url: string } & Record<string, unknown>

export type FakeGitlabCall = {
  args: string[]
  options?: GlabExecOptions
  method: string
  resource: string
}

export type FakeGitlabOptions = {
  host?: string
  projectId?: number
  projectStatus?: number
  permissionStatus?: number
  failCreate?: boolean
  rejectEvents?: string[]
  /** Fails every hook write with this HTTP status once set. */
  writeStatus?: number | null
  /** Runs before any response, so a test can gate a step or observe the ledger mid-flight. */
  onCall?: (call: FakeGitlabCall) => void | Promise<void>
  /** Runs while a hook create/update is in flight, before the response is produced. */
  onHookWrite?: (call: FakeGitlabCall) => void | Promise<void>
}

const STATUS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  401: 'Unauthorized',
  403: 'Forbidden',
  422: 'Unprocessable Entity'
}

export function http(status: number, body?: unknown): string {
  const text = body === undefined ? '' : JSON.stringify(body)
  return `HTTP/1.1 ${status} ${STATUS[status] ?? ''}\r\nContent-Type: application/json\r\n\r\n${text}`
}

function parseArgs(args: string[]): { method: string; resource: string } {
  let method = 'GET'
  let resource = ''
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--method') {
      method = args[++i]
    } else if (arg === '--hostname') {
      i++
    } else if (arg !== '--input' && arg !== '-' && arg !== 'api' && arg !== '-i') {
      resource = arg
    }
  }
  return { method, resource }
}

export function fakeGitlab(opts: FakeGitlabOptions = {}) {
  const host = opts.host ?? 'gitlab.test:8929'
  const projectId = opts.projectId ?? 3
  const hooks: FakeHook[] = []
  const created: { method: string; body: Record<string, unknown> }[] = []
  const deleted: number[] = []
  const calls: FakeGitlabCall[] = []
  let nextId = 1
  let writeStatus = opts.writeStatus ?? null

  const exec: Exec = async (args, options) => {
    const { method, resource } = parseArgs(args)
    const call: FakeGitlabCall = { args: [...args], options, method, resource }
    calls.push(call)
    await opts.onCall?.(call)

    if (resource === 'user') {
      return { stdout: http(200, { username: 'root', email: null }), stderr: '' }
    }
    if (resource.endsWith('hooks?per_page=1')) {
      return { stdout: http(opts.permissionStatus ?? 200, []), stderr: '' }
    }
    if (resource.includes('/hooks/')) {
      await opts.onHookWrite?.(call)
      const id = Number(resource.split('/').at(-1))
      if (method === 'DELETE') {
        const index = hooks.findIndex((hook) => hook.id === id)
        if (index !== -1) {
          hooks.splice(index, 1)
          deleted.push(id)
        }
        return { stdout: http(204), stderr: '' }
      }
      if (writeStatus !== null) {
        return { stdout: http(writeStatus, { message: 'write denied' }), stderr: '' }
      }
      const body: Record<string, unknown> = options?.stdin ? JSON.parse(options.stdin) : {}
      const existing = hooks.find((hook) => hook.id === id)
      if (!existing) {
        hooks.push({ id, project_id: projectId, url: String(body.url), ...body })
      } else {
        Object.assign(existing, body, { id, project_id: projectId })
        for (const flag of opts.rejectEvents ?? []) {
          existing[flag] = false
        }
      }
      created.push({ method, body })
      return {
        stdout: http(
          200,
          hooks.find((hook) => hook.id === id)
        ),
        stderr: ''
      }
    }
    if (resource.includes('/hooks')) {
      if (method === 'GET') {
        return { stdout: http(200, hooks), stderr: '' }
      }
      await opts.onHookWrite?.(call)
      if (opts.failCreate) {
        throw new Error('network down')
      }
      if (writeStatus !== null) {
        return { stdout: http(writeStatus, { message: 'write denied' }), stderr: '' }
      }
      const body: Record<string, unknown> = options?.stdin ? JSON.parse(options.stdin) : {}
      const hook: FakeHook = {
        id: nextId++,
        project_id: projectId,
        url: String(body.url ?? ''),
        ...body
      }
      for (const flag of opts.rejectEvents ?? []) {
        hook[flag] = false
      }
      hooks.push(hook)
      created.push({ method, body })
      return { stdout: http(201, hook), stderr: '' }
    }
    if (resource.startsWith('projects/')) {
      return { stdout: http(opts.projectStatus ?? 200, { id: projectId }), stderr: '' }
    }
    throw new Error(`unexpected resource ${resource}`)
  }

  return {
    host,
    projectId,
    exec,
    hooks,
    created,
    deleted,
    calls,
    setWriteStatus(status: number | null) {
      writeStatus = status
    }
  }
}

export type FakeGitlab = ReturnType<typeof fakeGitlab>

export function fakeStore(overrides: Partial<SecretStore> = {}): SecretStore {
  return {
    isEncryptionAvailable: () => true,
    describeProtectionGap: () => null,
    encryptString(plain) {
      return Buffer.from(`sealed:${plain}`, 'utf8')
    },
    decryptString(cipher) {
      const text = cipher.toString('utf8')
      if (!text.startsWith('sealed:')) {
        throw new Error('bad ciphertext')
      }
      return text.slice('sealed:'.length)
    },
    ...overrides
  }
}

export const receiverBaseUrl = 'https://orca.example.com'

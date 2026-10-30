import { describe, expect, it } from 'vitest'
import { resolveGitlabProjectIdentity, verifyGitlabHookPermission } from './gitlab-project-identity'
import type { GlabExecOptions } from '../git/command-runner/glab-exec-file'

const host = 'gitlab.test:8929'
const path = 'group/subgroup/project'
const projectId = 42

type Exec = (
  args: string[],
  options?: GlabExecOptions
) => Promise<{ stdout: string; stderr: string }>

function okResponse(body: unknown): string {
  return `HTTP/1.1 200 OK\nContent-Type: application/json\n\n${JSON.stringify(body)}`
}

function httpError(code: number, message = `${code} simulated`): string {
  return `HTTP/1.1 ${code} \nContent-Type: application/json\n\n${JSON.stringify({ message })}`
}

function setup(
  overrides: {
    exec?: Exec
    explicitProjectRef?: { host: string; path: string } | null
    resolveProjectRef?: () => Promise<{ host: string; path: string } | null>
  } = {}
) {
  const calls: string[][] = []
  const exec: Exec =
    overrides.exec ??
    (async (args) => {
      calls.push(args)
      const endpoint = args.at(-1) ?? ''
      if (endpoint === `projects/${encodeURIComponent(path)}`) {
        return { stdout: okResponse({ id: projectId, path_with_namespace: path }), stderr: '' }
      }
      if (endpoint === 'user') {
        return { stdout: okResponse({ username: 'root', email: null }), stderr: '' }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    })
  const explicitProjectRef =
    overrides.explicitProjectRef === undefined ? { host, path } : overrides.explicitProjectRef
  return { exec, calls, explicitProjectRef, resolveProjectRef: overrides.resolveProjectRef }
}

describe('trusted GitLab project identity', () => {
  it('resolves host, path, numeric project id and current user from an explicit ref', async () => {
    const { exec, explicitProjectRef } = setup()
    const result = await resolveGitlabProjectIdentity({
      repoPath: '/repo',
      explicitProjectRef,
      exec
    })
    expect(result).toEqual({
      ok: true,
      identity: { host, path, projectId, viewer: { username: 'root', email: null } }
    })
  })

  it('resolves the project ref from the remote when none is explicit', async () => {
    const { exec, resolveProjectRef } = setup({
      resolveProjectRef: async () => ({ host, path })
    })
    const result = await resolveGitlabProjectIdentity({
      repoPath: '/repo',
      resolveProjectRef,
      exec
    })
    expect(result).toEqual({
      ok: true,
      identity: { host, path, projectId, viewer: { username: 'root', email: null } }
    })
  })

  it('reports not-gitlab when no project ref can be resolved', async () => {
    const { exec, resolveProjectRef } = setup({ resolveProjectRef: async () => null })
    const result = await resolveGitlabProjectIdentity({
      repoPath: '/repo',
      resolveProjectRef,
      exec
    })
    expect(result).toEqual({ ok: false, code: 'not-gitlab' })
  })

  it('never puts credentials in argv and always targets the resolved host', async () => {
    const { exec, explicitProjectRef, calls } = setup()
    await resolveGitlabProjectIdentity({ repoPath: '/repo', explicitProjectRef, exec })
    for (const args of calls) {
      expect(args).toContain('--hostname')
      expect(args).toContain(host)
      expect(args.join(' ')).not.toMatch(/token|password|secret/i)
    }
  })

  it('classifies a missing glab binary as glab-unavailable', async () => {
    const { explicitProjectRef } = setup()
    const result = await resolveGitlabProjectIdentity({
      repoPath: '/repo',
      explicitProjectRef,
      exec: async () => {
        throw Object.assign(new Error('spawn glab ENOENT'), {
          code: 'ENOENT',
          syscall: 'spawn glab'
        })
      }
    })
    expect(result).toEqual({ ok: false, code: 'glab-unavailable' })
  })

  it('classifies an unauthenticated project read from the status line', async () => {
    const { explicitProjectRef } = setup()
    const result = await resolveGitlabProjectIdentity({
      repoPath: '/repo',
      explicitProjectRef,
      exec: async () => ({ stdout: httpError(401), stderr: '' })
    })
    expect(result).toEqual({ ok: false, code: 'unauthenticated' })
  })

  it('classifies a forbidden project read', async () => {
    const { explicitProjectRef } = setup()
    const result = await resolveGitlabProjectIdentity({
      repoPath: '/repo',
      explicitProjectRef,
      exec: async () => ({ stdout: httpError(403), stderr: '' })
    })
    expect(result).toEqual({ ok: false, code: 'forbidden' })
  })

  it('classifies a missing project as project-not-found', async () => {
    const { explicitProjectRef } = setup()
    const result = await resolveGitlabProjectIdentity({
      repoPath: '/repo',
      explicitProjectRef,
      exec: async () => ({ stdout: httpError(404), stderr: '' })
    })
    expect(result).toEqual({ ok: false, code: 'project-not-found' })
  })

  it('classifies a non-object project response as bad-response', async () => {
    const { explicitProjectRef } = setup()
    const result = await resolveGitlabProjectIdentity({
      repoPath: '/repo',
      explicitProjectRef,
      exec: async () => ({ stdout: okResponse([1, 2, 3]), stderr: '' })
    })
    expect(result).toEqual({ ok: false, code: 'bad-response' })
  })

  it('classifies a network failure', async () => {
    const { explicitProjectRef } = setup()
    const result = await resolveGitlabProjectIdentity({
      repoPath: '/repo',
      explicitProjectRef,
      exec: async () => {
        throw Object.assign(new Error('network failed'), { stderr: 'network failed' })
      }
    })
    expect(result).toEqual({ ok: false, code: 'network' })
  })

  it('does not query after caller cancellation', async () => {
    const { explicitProjectRef, calls } = setup()
    const controller = new AbortController()
    controller.abort()
    const result = await resolveGitlabProjectIdentity({
      repoPath: '/repo',
      explicitProjectRef,
      signal: controller.signal,
      exec: async (args) => {
        calls.push(args)
        return { stdout: okResponse({ id: projectId }), stderr: '' }
      }
    })
    expect(result).toEqual({ ok: false, code: 'aborted' })
    expect(calls).toEqual([])
  })
})

describe('GitLab project hook permission', () => {
  it('reports permission when the hooks list is readable', async () => {
    const calls: string[][] = []
    const result = await verifyGitlabHookPermission({
      repoPath: '/repo',
      host,
      projectId,
      exec: async (args) => {
        calls.push(args)
        return { stdout: okResponse([]), stderr: '' }
      }
    })
    expect(result).toEqual({ ok: true })
    expect(calls[0]?.at(-1)).toBe(`projects/${projectId}/hooks?per_page=1`)
  })

  it('reports no-hook-permission when listing hooks is forbidden', async () => {
    const result = await verifyGitlabHookPermission({
      repoPath: '/repo',
      host,
      projectId,
      exec: async () => ({ stdout: httpError(403), stderr: '' })
    })
    expect(result).toEqual({ ok: false, code: 'no-hook-permission' })
  })

  it('reports unauthenticated when the hooks list rejects the login', async () => {
    const result = await verifyGitlabHookPermission({
      repoPath: '/repo',
      host,
      projectId,
      exec: async () => ({ stdout: httpError(401), stderr: '' })
    })
    expect(result).toEqual({ ok: false, code: 'unauthenticated' })
  })
})

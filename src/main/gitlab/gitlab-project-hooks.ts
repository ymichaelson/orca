import { z } from 'zod'
import {
  createGitlabProjectHookApi,
  gitlabManagedHookSchema,
  GitlabProjectHookError,
  validGitlabHookScope,
  type GitlabManagedHook,
  type GitlabProjectHookFailureCode,
  type GitlabProjectHookScope
} from './gitlab-project-hook-api'

const EVENT_FLAGS = [
  'push_events',
  'issues_events',
  'confidential_issues_events',
  'merge_requests_events',
  'tag_push_events',
  'note_events',
  'confidential_note_events',
  'emoji_events',
  'job_events',
  'pipeline_events',
  'wiki_page_events',
  'deployment_events',
  'releases_events',
  'milestone_events',
  'feature_flag_events',
  'resource_access_token_events',
  'resource_deploy_token_events'
] as const
const HOOK_NAME = 'Orca project event Agent'
const bindingIdSchema = z.uuid()
const listSchema = z.array(gitlabManagedHookSchema).max(100)
const pendingHookMutations = new Map<string, Promise<void>>()

type Failure = {
  ok: false
  code: Exclude<GitlabProjectHookFailureCode, 'event-configuration-rejected'>
}
export type GitlabProjectHookRegistration = {
  bindingId: string
  callbackUrl: string
  secret: string
  hookId?: number
}
export type GitlabProjectHookResult =
  | Failure
  | {
      ok: false
      code: 'event-configuration-rejected'
      hookId: number
      callbackUrl: string
      // Why: a partial rejection still accepts some flags, so callers can report what delivers.
      enabledEvents: string[]
      unsupportedEvents: string[]
      rejectedEvents: string[]
    }
  | {
      ok: true
      hookId: number
      callbackUrl: string
      enabledEvents: string[]
      unsupportedEvents: string[]
    }

function description(bindingId: string): string {
  return `orca-project-event-binding:${bindingId}`
}

function owned(hook: GitlabManagedHook, bindingId: string): boolean {
  return hook.name === HOOK_NAME && hook.description === description(bindingId)
}

function validRegistration(input: GitlabProjectHookRegistration): boolean {
  if (
    !bindingIdSchema.safeParse(input.bindingId).success ||
    !/^[\x21-\x7e]{1,8192}$/.test(input.secret)
  ) {
    return false
  }
  try {
    if (/[\s\\?#]/.test(input.callbackUrl)) {
      return false
    }
    const url = new URL(input.callbackUrl)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !['0.0.0.0', '[::]'].includes(url.hostname) &&
      url.pathname.endsWith(`/webhooks/gitlab/${input.bindingId}`) &&
      (input.hookId === undefined || (Number.isSafeInteger(input.hookId) && input.hookId > 0))
    )
  } catch {
    return false
  }
}

function failure(error: unknown, writeAttempted: boolean): Failure {
  const code =
    error instanceof GitlabProjectHookError && error.code !== 'event-configuration-rejected'
      ? error.code
      : 'bad-response'
  return {
    ok: false,
    code:
      writeAttempted && ['network', 'aborted', 'bad-response'].includes(code)
        ? 'unknown-outcome'
        : code
  }
}

export function createGitlabProjectHookClient(scope: GitlabProjectHookScope) {
  const api = createGitlabProjectHookApi(scope)
  const list = async (signal?: AbortSignal): Promise<GitlabManagedHook[]> => {
    const hooks: GitlabManagedHook[] = []
    for (let page = 1; page <= 10; page++) {
      const parsed = listSchema.safeParse(await api('GET', `?per_page=100&page=${page}`, signal))
      if (
        !parsed.success ||
        parsed.data.some((hook) => hook.project_id !== Number(scope.projectId))
      ) {
        throw new GitlabProjectHookError('bad-response')
      }
      hooks.push(...parsed.data)
      if (parsed.data.length < 100) {
        return hooks
      }
    }
    throw new GitlabProjectHookError('too-many-hooks')
  }
  const client = {
    async ensure(
      input: GitlabProjectHookRegistration,
      signal?: AbortSignal
    ): Promise<GitlabProjectHookResult> {
      if (!validGitlabHookScope(scope) || !validRegistration(input)) {
        return { ok: false, code: 'invalid-config' }
      }
      let writeAttempted = false
      try {
        const hooks = await list(signal)
        const matches = hooks.filter((hook) => owned(hook, input.bindingId))
        const known = hooks.find((hook) => hook.id === input.hookId)
        if (
          matches.length > 1 ||
          (known && !owned(known, input.bindingId)) ||
          hooks.some((hook) => hook.url === input.callbackUrl && !owned(hook, input.bindingId))
        ) {
          return { ok: false, code: 'ownership-conflict' }
        }
        const existing = matches[0]
        if (signal?.aborted) {
          return { ok: false, code: 'aborted' }
        }
        const body = {
          name: HOOK_NAME,
          description: description(input.bindingId),
          url: input.callbackUrl,
          token: input.secret,
          enable_ssl_verification: true,
          branch_filter_strategy: 'all_branches',
          ...Object.fromEntries(EVENT_FLAGS.map((flag) => [flag, true]))
        }
        writeAttempted = true
        const raw = await api(
          existing ? 'PUT' : 'POST',
          existing ? `/${existing.id}` : '',
          signal,
          body
        )
        const parsed = gitlabManagedHookSchema.safeParse(raw)
        if (
          !parsed.success ||
          parsed.data.project_id !== Number(scope.projectId) ||
          parsed.data.url !== input.callbackUrl ||
          !owned(parsed.data, input.bindingId) ||
          (existing && parsed.data.id !== existing.id)
        ) {
          throw new GitlabProjectHookError('bad-response')
        }
        const hook = parsed.data
        if (EVENT_FLAGS.some((flag) => hook[flag] !== undefined && hook[flag] !== true)) {
          return {
            ok: false,
            code: 'event-configuration-rejected',
            hookId: hook.id,
            callbackUrl: hook.url,
            enabledEvents: EVENT_FLAGS.filter((flag) => hook[flag] === true),
            unsupportedEvents: EVENT_FLAGS.filter((flag) => hook[flag] === undefined),
            rejectedEvents: EVENT_FLAGS.filter(
              (flag) => hook[flag] !== undefined && hook[flag] !== true
            )
          }
        }
        return {
          ok: true,
          hookId: hook.id,
          callbackUrl: hook.url,
          enabledEvents: EVENT_FLAGS.filter((flag) => hook[flag] === true),
          unsupportedEvents: EVENT_FLAGS.filter((flag) => hook[flag] === undefined)
        }
      } catch (error) {
        return failure(error, writeAttempted)
      }
    },
    async remove(
      input: { bindingId: string; hookId?: number },
      signal?: AbortSignal
    ): Promise<{ ok: true } | Failure> {
      if (
        !validGitlabHookScope(scope) ||
        !bindingIdSchema.safeParse(input.bindingId).success ||
        (input.hookId !== undefined && (!Number.isSafeInteger(input.hookId) || input.hookId <= 0))
      ) {
        return { ok: false, code: 'invalid-config' }
      }
      let writeAttempted = false
      try {
        const hooks = await list(signal)
        const matches = hooks.filter((entry) => owned(entry, input.bindingId))
        if (matches.length > 1) {
          return { ok: false, code: 'ownership-conflict' }
        }
        const requested = hooks.find((entry) => entry.id === input.hookId)
        if (requested && !owned(requested, input.bindingId)) {
          return { ok: false, code: 'ownership-conflict' }
        }
        const hook = matches[0]
        if (!hook) {
          return { ok: true }
        }
        if (signal?.aborted) {
          return { ok: false, code: 'aborted' }
        }
        writeAttempted = true
        await api('DELETE', `/${hook.id}`, signal)
        return { ok: true }
      } catch (error) {
        if (
          writeAttempted &&
          error instanceof GitlabProjectHookError &&
          error.code === 'not-found'
        ) {
          return { ok: true }
        }
        return failure(error, writeAttempted)
      }
    }
  }
  const mutationKey = JSON.stringify([scope.connectionId ?? null, scope.host, scope.projectId])
  const serializeHookMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = pendingHookMutations.get(mutationKey) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    pendingHookMutations.set(mutationKey, tail)
    return result.finally(() => {
      if (pendingHookMutations.get(mutationKey) === tail) {
        pendingHookMutations.delete(mutationKey)
      }
    })
  }
  return {
    ensure: (input: GitlabProjectHookRegistration, signal?: AbortSignal) => {
      const request = { ...input }
      return serializeHookMutation(() => client.ensure(request, signal))
    },
    remove: (input: { bindingId: string; hookId?: number }, signal?: AbortSignal) => {
      const request = { ...input }
      return serializeHookMutation(() => client.remove(request, signal))
    }
  }
}

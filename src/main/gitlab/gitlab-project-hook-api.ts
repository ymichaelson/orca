import { z } from 'zod'
import {
  createGitlabProjectApi,
  GitlabProjectApiError,
  type GitlabProjectApiFailureCode,
  type GitlabProjectApiScope
} from './gitlab-project-api'

export const gitlabManagedHookSchema = z
  .object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    project_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    url: z.string().max(4096),
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional()
  })
  .catchall(z.unknown())

export type GitlabManagedHook = z.infer<typeof gitlabManagedHookSchema>

export function validGitlabHookScope(scope: GitlabProjectApiScope): boolean {
  try {
    const url = new URL(`https://${scope.host}`)
    return (
      url.host === scope.host &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^[1-9][0-9]{0,15}$/.test(scope.projectId) &&
      Number.isSafeInteger(Number(scope.projectId)) &&
      scope.repoPath.length > 0
    )
  } catch {
    return false
  }
}

export function createGitlabProjectHookApi(scope: GitlabProjectApiScope) {
  const api = createGitlabProjectApi(scope)
  return (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    resource: string,
    signal?: AbortSignal,
    body?: Readonly<Record<string, unknown>>
  ): Promise<unknown> => api(method, `hooks${resource}`, signal, body)
}

export type GitlabProjectHookFailureCode = GitlabProjectApiFailureCode
export type GitlabProjectHookScope = GitlabProjectApiScope
export { GitlabProjectApiError as GitlabProjectHookError }

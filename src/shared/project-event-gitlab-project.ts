/**
 * Raw text the user typed for a folder workspace's GitLab project; the execution host parses it.
 * `null` clears the association; blank or malformed input changes nothing.
 */
export function normalizeProjectEventGitlabProject(value: unknown): string | null | undefined {
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    return undefined
  }
  const text = value.trim()
  return text.length > 0 ? text : undefined
}

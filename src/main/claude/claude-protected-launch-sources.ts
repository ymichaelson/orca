import type { ProtectedClaudeAuthDeps } from './claude-protected-auth'

export type ProtectedClaudeLaunchSources = {
  getSettings: ProtectedClaudeAuthDeps['getSettings']
  scanRoots: () => readonly string[] | Promise<readonly string[]>
}

let sources: ProtectedClaudeLaunchSources | null = null

/** Installed by the host that founds protected chats; absent, every protected launch is refused. */
export function configureProtectedClaudeLaunchSources(
  next: ProtectedClaudeLaunchSources | null
): void {
  sources = next
}

export function requireProtectedClaudeLaunchSources(): ProtectedClaudeLaunchSources {
  if (!sources) {
    throw new Error('protected_claude_launch_unavailable')
  }
  return sources
}

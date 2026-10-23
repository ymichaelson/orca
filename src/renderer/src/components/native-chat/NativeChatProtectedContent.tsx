import React, { createContext, useContext } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useStructuredAgentSessionProtectedAnalysis } from './StructuredAgentSessionStatusBridge'

/** A protected analysis's transcript is untrusted text, so every Markdown surface under this
 *  provider draws inertly: no remote media, no raw HTML, and no link that opens unnamed. */
const NativeChatProtectedContentContext = createContext(false)

export function useNativeChatProtectedContent(): boolean {
  return useContext(NativeChatProtectedContentContext)
}

/** At the chat view's entry, so the transcript, its prompt cards and its link actions all read
 *  one session the same way. */
export function NativeChatProtectedContentBoundary({
  sessionId,
  target,
  children
}: {
  sessionId: string
  target: RuntimeClientTarget
  children: React.ReactNode
}): React.JSX.Element {
  const protectedAnalysis = useStructuredAgentSessionProtectedAnalysis(sessionId, target)
  return (
    <NativeChatProtectedContentContext.Provider value={protectedAnalysis}>
      {children}
    </NativeChatProtectedContentContext.Provider>
  )
}

// Build durable-record access lazily and scope every restart offer action to agents this client renders.
// Listing spends no offer; resume re-derives eligibility from host state, never trusts supplied ids.

import { defineMethod } from '../core'
import {
  clientReadsProtectedSession,
  ensureStructuredHostInstalled,
  requireProtectedOutputReader,
  requireStructuredHost,
  structuredCallerFor
} from './structured-agent-session-gate'
import {
  ContinueInterruptedParams,
  RestartResumableParams,
  RestartResumeParams
} from './structured-agent-session-schemas'
import { structuredAgentsReadBy } from './structured-agent-session-policy'

export const STRUCTURED_AGENT_SESSION_RESTART_RESUME_METHODS = [
  defineMethod({
    name: 'agentSession.restartResumable',
    permission: 'workspace',
    params: RestartResumableParams,
    handler: async (_params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      const audience = structuredAgentsReadBy(ctx, host.knownAgentIds())
      // A protected analysis continues through Forge, never through this dialog: an ordinary
      // client is not even told the offer exists.
      const readable = (row: { sessionId: string }) =>
        clientReadsProtectedSession(ctx, host, row.sessionId)
      return {
        sessions: (await host.restartResume.list(audience)).filter(readable),
        // Acted-on offers whose agent did not carry on. Optional on the wire; older clients ignore it.
        failed: (await host.restartResume.listFailures(audience)).filter(readable)
      }
    }
  }),
  defineMethod({
    // Explicit dismissal abandons markers; dialog close only snoozes so the status-bar offer remains.
    name: 'agentSession.restartResumableDismiss',
    permission: 'workspace',
    params: RestartResumableParams,
    handler: async (params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      // Offers this client was never shown stay for a client that can show them.
      const audience = structuredAgentsReadBy(ctx, host.knownAgentIds())
      const dismissed = await host.restartResume.dismiss(params.sessionIds, audience)
      if (params.sessionIds === undefined) {
        // Dismissal already removed everything this client sees; another read adds only a post-success failure point.
        return { dismissed, sessions: [], failed: [] }
      }
      return {
        dismissed,
        sessions: await host.restartResume.list(audience),
        failed: await host.restartResume.listFailures(audience)
      }
    }
  }),
  defineMethod({
    // Reattach and ask agents to continue, for prompt/settings resume; legacy restartResume sends nothing.
    name: 'agentSession.restartContinue',
    permission: 'workspace',
    params: RestartResumeParams,
    handler: async (params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      const audience = structuredAgentsReadBy(ctx, host.knownAgentIds())
      // Omitting the ids means "every offer this client sees", so the offer set has to be named
      // first: otherwise a client that cannot render a protected analysis would still continue it.
      const sessionIds =
        params.sessionIds ??
        (await host.restartResume.list(audience)).map((offer) => offer.sessionId)
      return host.restartResume.continueAfterRestart(
        sessionIds.filter((sessionId) => clientReadsProtectedSession(ctx, host, sessionId)),
        structuredCallerFor(ctx).callerKey,
        audience
      )
    }
  }),
  defineMethod({
    // Continue the exact interrupted turn, separate from restart offers; clients negotiate its capability and name a readable chat.
    name: 'agentSession.continueInterrupted',
    permission: 'workspace',
    params: ContinueInterruptedParams,
    handler: async (params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      requireProtectedOutputReader(ctx, host, params.sessionId)
      return host.restartResume.continueInterrupted(params.sessionId, params.turnItemId)
    }
  }),
  defineMethod({
    // Keep published legacy reattach-only RPC answering no resume: agents now start only for work, and removal would break old clients.
    name: 'agentSession.restartResume',
    permission: 'workspace',
    params: RestartResumeParams,
    handler: async (_params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      requireStructuredHost(ctx)
      return { results: [] }
    }
  })
]

/** A client that draws protected analysis inertly: no remote images or media, no raw HTML, and no
 *  link that opens without naming its destination. Without it the host hands over no protected
 *  session at all — refusing one read is only as strong as the weakest surface that renders it. */
export const AGENT_SESSION_PROTECTED_OUTPUT_CLIENT_CAPABILITY =
  'agent-session.protected-output.v1' as const

/** The bundled desktop renderer ships with the main process, so this is a build fact, not a
 *  negotiation: its transcript draws protected content inertly, so it reads it. */
export const DESKTOP_RENDERER_READS_PROTECTED_OUTPUT = true

/** What a legacy reader that cannot draw a protected transcript inertly answers. */
export const PROTECTED_TRANSCRIPT_REFUSAL = 'Protected analysis: open it from the Inbox.'

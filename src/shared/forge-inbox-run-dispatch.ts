/** What a terminal's process did, host-observed and fixed in kind; never what the agent did. */
export const FORGE_RUN_TERMINAL_EXIT_KINDS = [
  'exited',
  'signaled',
  'operator_close',
  'unknown'
] as const
export type ForgeRunTerminalExitKind = (typeof FORGE_RUN_TERMINAL_EXIT_KINDS)[number]

export type ForgeRunTerminalExitView = {
  kind: ForgeRunTerminalExitKind
  /** The exit code or signal number the host reported; null when it proved neither. */
  value: number | null
  observedAt: number
}

/**
 * The Agent and model a dispatch was told to use, fixed when it was dispatched. A null requested
 * model is the Agent's own default; a null actual model is one the runtime never reported.
 */
export type ForgeRunDispatchSnapshotView = {
  agentId: string
  requestedModel: string | null
  actualModel: string | null
}

/** Both optional, so an older host's run still parses; absent never means unknown became known. */
export type ForgeRunDispatchViewFields = {
  dispatchSnapshot?: ForgeRunDispatchSnapshotView
  /** Present only once a host saw the terminal's process end; it is not the agent's result. */
  terminalExit?: ForgeRunTerminalExitView
}

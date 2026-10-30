import { translate } from '@/i18n/i18n'

// Why: run and agent-dispatch failures; the user acts on the agent, workspace or project settings.
export const RUN_ERROR_COPY: Record<string, () => string> = {
  'worker-error': () =>
    translate('auto.components.forge-inbox.display.errorWorker', 'The analysis worker failed.'),
  'analysis-failed': () =>
    translate('auto.components.forge-inbox.display.errorAnalysisFailed', 'The analysis failed.'),
  'output-budget': () =>
    translate(
      'auto.components.forge-inbox.display.errorOutputBudget',
      'The agent output exceeded its size limit.'
    ),
  'owner-stopped': () =>
    translate(
      'auto.components.forge-inbox.display.errorOwnerStopped',
      'The inbox stopped before this finished.'
    ),
  'unknown-outcome': () =>
    translate(
      'auto.components.forge-inbox.display.errorUnknownOutcome',
      'It is not known whether this finished.'
    ),
  'agent-failure': () =>
    translate('auto.components.forge-inbox.display.errorAgentFailure', 'The agent failed.'),
  cancelled: () => translate('auto.components.forge-inbox.display.errorCancelled', 'Cancelled.'),
  superseded: () =>
    translate('auto.components.forge-inbox.display.errorSuperseded', 'Replaced by a newer run.'),
  'terminal-handoff': () =>
    translate(
      'auto.components.forge-inbox.display.errorTerminalHandoff',
      'The agent was handed to a terminal.'
    ),
  'dispatch-failed': () =>
    translate(
      'auto.components.forge-inbox.display.errorDispatchFailed',
      'Starting the agent failed.'
    ),
  'dispatch-unconfigured': () =>
    translate(
      'auto.components.forge-inbox.display.errorDispatchUnconfigured',
      'No agent is configured for this project.'
    ),
  'dispatch-prompt-undelivered': () =>
    translate(
      'auto.components.forge-inbox.display.errorPromptUndelivered',
      'The prompt was not delivered to the agent.'
    ),
  'dispatch-turn-unbound': () =>
    translate(
      'auto.components.forge-inbox.display.errorTurnUnbound',
      'The agent turn could not be tracked.'
    ),
  'dispatch-session-unbound': () =>
    translate(
      'auto.components.forge-inbox.display.errorSessionUnbound',
      'The agent session could not be tracked.'
    ),
  'dispatch-prompt-too-large-for-terminal': () =>
    translate(
      'auto.components.forge-inbox.display.errorPromptTooLarge',
      'The prompt is too large to send to a terminal.'
    ),
  'structured-agent-session-unsupported': () =>
    translate(
      'auto.components.forge-inbox.display.errorStructuredUnsupported',
      'This agent cannot run in a structured session.'
    ),
  'workspace-unresolved': () =>
    translate(
      'auto.components.forge-inbox.display.errorWorkspaceUnresolved',
      'No workspace was found for this change.'
    ),
  'workspace-remote-unsupported': () =>
    translate(
      'auto.components.forge-inbox.display.errorWorkspaceRemote',
      'Remote workspaces are not supported here.'
    ),
  'workspace-ambiguous': () =>
    translate(
      'auto.components.forge-inbox.display.errorWorkspaceAmbiguous',
      'More than one workspace matches this change.'
    ),
  'workspace-repo-mismatch': () =>
    translate(
      'auto.components.forge-inbox.display.errorWorkspaceMismatch',
      'The workspace belongs to a different project.'
    ),
  'agent-unavailable': () =>
    translate(
      'auto.components.forge-inbox.display.errorAgentUnavailable',
      'The agent is unavailable.'
    ),
  'dispatch-unavailable': () =>
    translate(
      'auto.components.forge-inbox.display.errorDispatchUnavailable',
      'Agent dispatch is unavailable on this host.'
    ),
  'dispatch-unverifiable': () =>
    translate(
      'auto.components.forge-inbox.display.errorDispatchUnverifiable',
      'The agent start could not be confirmed.'
    ),
  'action-failed': () =>
    translate(
      'auto.components.forge-inbox.display.errorActionFailed',
      'The action failed unexpectedly.'
    ),
  'action-unsupported': () =>
    translate(
      'auto.components.forge-inbox.display.errorActionUnsupported',
      'Orca cannot run this action yet.'
    ),
  aborted: () =>
    translate(
      'auto.components.forge-inbox.display.errorAborted',
      'The work was stopped before it finished.'
    ),
  'already-dispatched': () =>
    translate(
      'auto.components.forge-inbox.display.errorAlreadyDispatched',
      'An agent already handled this change.'
    ),
  'awaiting-user': () =>
    translate('auto.components.forge-inbox.display.errorAwaitingUser', 'Waiting for your answer.'),
  'crash-loop': () =>
    translate(
      'auto.components.forge-inbox.display.errorCrashLoop',
      'Orca stopped retrying this event after repeated crashes.'
    ),
  'dispatch-needs-observation': () =>
    translate(
      'auto.components.forge-inbox.display.errorDispatchNeedsObservation',
      'The change must be read from GitLab before an agent can start.'
    ),
  'interrupted-action': () =>
    translate(
      'auto.components.forge-inbox.display.errorInterruptedAction',
      'The action was interrupted.'
    ),
  'interrupted-decision': () =>
    translate(
      'auto.components.forge-inbox.display.errorInterruptedDecision',
      'The decision was interrupted.'
    )
}

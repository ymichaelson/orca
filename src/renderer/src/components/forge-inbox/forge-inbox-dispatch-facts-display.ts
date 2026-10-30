import { translate } from '@/i18n/i18n'
import type {
  ForgeRunDispatchSnapshotView,
  ForgeRunTerminalExitView
} from '../../../../shared/forge-inbox-run-dispatch'

/** What the dispatch was told to use; an absent requested model is the Agent's own default. */
export function forgeDispatchSnapshotLines(snapshot: ForgeRunDispatchSnapshotView): string[] {
  const lines = [
    translate('auto.components.forge-inbox.display.dispatchAgent', 'Agent: {{agent}}', {
      agent: snapshot.agentId
    }),
    snapshot.requestedModel === null
      ? translate(
          'auto.components.forge-inbox.display.dispatchModelDefault',
          'Model requested: Agent default'
        )
      : translate(
          'auto.components.forge-inbox.display.dispatchModelRequested',
          'Model requested: {{model}}',
          { model: snapshot.requestedModel }
        )
  ]
  if (snapshot.actualModel !== null) {
    lines.push(
      translate(
        'auto.components.forge-inbox.display.dispatchModelReported',
        'Model reported: {{model}}',
        { model: snapshot.actualModel }
      )
    )
  }
  return lines
}

/** The process outcome, always followed by what it does not say, so an exit never reads as a result. */
export function forgeTerminalExitLines(exit: ForgeRunTerminalExitView): string[] {
  const fact =
    exit.kind === 'exited' && exit.value !== null
      ? translate(
          'auto.components.forge-inbox.display.terminalExitCode',
          'The terminal process exited with code {{code}}.',
          { code: exit.value }
        )
      : exit.kind === 'signaled' && exit.value !== null
        ? translate(
            'auto.components.forge-inbox.display.terminalExitSignal',
            'The terminal process was stopped by signal {{signal}}.',
            { signal: exit.value }
          )
        : exit.kind === 'operator_close'
          ? translate(
              'auto.components.forge-inbox.display.terminalExitClosed',
              'The terminal was closed from Orca.'
            )
          : translate(
              'auto.components.forge-inbox.display.terminalExitUnknown',
              'The terminal process ended; why is not known.'
            )
  return [
    fact,
    translate(
      'auto.components.forge-inbox.display.terminalExitNoResult',
      'This does not show what the agent did.'
    )
  ]
}

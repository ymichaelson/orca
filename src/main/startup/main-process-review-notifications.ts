import { app, Notification, shell } from 'electron'
import { join } from 'node:path'
import { mainProcessState as state } from './main-process-state'
import { TUI_AGENT_AUTO_PICK_ORDER } from '../../shared/tui-agent-selection'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'
import { createFileWatermarkStore } from '../review-notifications/dedup'
import { createReviewDelivery } from '../review-notifications/delivery'
import { ReviewNotificationPoller } from '../review-notifications/poller'
import { buildSummarizePrompt, createOneShotAgentRunner } from '../review-notifications/summarize'
import { describeReviewEvent, type ReviewEvent } from '../review-notifications/review-event'

/** How often the job set is rebuilt from repo configs (picks up Settings edits). */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000

function resolveSummarizeAgent(): TuiAgent | null {
  const preferred = state.store?.getSettings().defaultTuiAgent
  if (preferred && preferred !== 'blank') {
    return preferred
  }
  const first = TUI_AGENT_AUTO_PICK_ORDER[0]
  return first !== undefined && isTuiAgent(first) ? first : null
}

async function handleSummarize(event: ReviewEvent): Promise<void> {
  const runner = createOneShotAgentRunner({ agentId: resolveSummarizeAgent() })
  const outcome = await runner(buildSummarizePrompt(event))
  const summary = outcome.ok ? outcome.summary : outcome.error
  const notification = new Notification({
    title: `Summary: ${describeReviewEvent(event)}`,
    body: summary.slice(0, 1000)
  })
  notification.on('click', () => {
    if (event.url) {
      void shell.openExternal(event.url)
    }
  })
  notification.show()
}

/**
 * Start the phase-1a review-notification poller. Idle unless at least one repo
 * opts in and the global kill-switch is on. Safe to call once at startup.
 */
export function initializeMainProcessReviewNotifications(): ReviewNotificationPoller | null {
  const store = state.store
  if (!store) {
    throw new Error('Store must be initialized before review notifications')
  }
  if (state.reviewNotificationPoller) {
    return state.reviewNotificationPoller
  }
  const stateFile = join(app.getPath('userData'), 'review-notifications', 'state.json')
  const watermarkStore = createFileWatermarkStore(stateFile)
  const delivery = createReviewDelivery({
    onSummarize: (event) => {
      void handleSummarize(event)
    }
  })
  const poller = new ReviewNotificationPoller({
    getRepos: () => store.getRepos(),
    getGlobalEnabled: () => store.getSettings().reviewNotificationsEnabled !== false,
    store: watermarkStore,
    delivery,
    onHealth: (repoId, provider, error) => {
      // Quiet health badge: log only, never notify on poller failures.
      if (error) {
        console.warn(`[review-notifications] ${provider} poll failed for repo ${repoId}: ${error}`)
      }
    }
  })
  poller.start()
  // The global kill-switch must take effect immediately.
  store.onSettingsChanged(() => {
    poller.reconcile()
  })
  const reconcileTimer = setInterval(() => {
    poller.reconcile()
  }, RECONCILE_INTERVAL_MS)
  reconcileTimer.unref?.()
  state.reviewNotificationPoller = poller
  return poller
}

export function getReviewNotificationPoller(): ReviewNotificationPoller | null {
  return state.reviewNotificationPoller
}

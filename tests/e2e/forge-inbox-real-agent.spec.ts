/**
 * Real-agent end-to-end: a seeded `dispatch_agent` decision is drained by the shipped owner service,
 * which launches a real Claude turn against a real repo. The test asserts the run the app recorded
 * and the state the Inbox renders — it never fabricates the agent's answer.
 *
 * Opt-in: it spends real model calls and needs this machine's agent credentials, so a CI without
 * ORCA_E2E_REAL_AGENT=1 skips it instead of silently passing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from '@stablyai/playwright-test'
import { DatabaseSync } from 'node:sqlite'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { seedRealAgentDispatch } from './helpers/forge-inbox-real-agent-seed'
import { createSeededTestRepo } from './helpers/seeded-test-repo'
import { runFromRow } from '../../src/main/forge-inbox/forge-inbox-rows'
import type { ForgeRun } from '../../src/shared/forge-inbox-types'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'

test.use({ screenshot: 'off' })
test.setTimeout(600_000)

const REAL_AGENT_ENABLED = process.env.ORCA_E2E_REAL_AGENT === '1'
const FINAL_RUN_STATES = new Set(['succeeded', 'failed', 'cancelled', 'unverifiable', 'superseded'])

async function capture(page: Page, directory: string, name: string): Promise<string> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(directory, `${name}.png`)
    writeFileSync(file, Buffer.from(data, 'base64'), { flag: 'wx' })
    return file
  } finally {
    await cdp.detach()
  }
}

/** Read-only, so polling never blocks or perturbs the owner that holds the ledger. */
function readLatestRun(dbPath: string): ForgeRun | null {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get()
    return row === undefined ? null : runFromRow(row)
  } finally {
    db.close()
  }
}

test('launches a real agent for a dispatched project event', async () => {
  test.skip(!REAL_AGENT_ENABLED, 'set ORCA_E2E_REAL_AGENT=1 to spend a real model call')
  const testInfo = test.info()
  const screenshotsRoot = path.join(process.cwd(), 'validation-screenshots')
  mkdirSync(screenshotsRoot, { recursive: true })
  const screenshots = mkdtempSync(path.join(screenshotsRoot, 'forge-real-agent-'))
  const repoPath = createSeededTestRepo()
  const session = createRestartSession(testInfo, {
    DO_NOT_TRACK: '1',
    ORCA_TELEMETRY_DISABLED: '1'
  })
  writeFileSync(
    path.join(session.userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(true), null, 2)}\n`
  )
  let running: ElectronApplication | null = null
  try {
    const first = await session.launch()
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    const repoId = await first.page.evaluate(async (wtId) => {
      const store = window.__store
      if (!store) {
        throw new Error('store unavailable')
      }
      const state = store.getState()
      const found =
        Object.entries(state.worktreesByRepo).find(([, worktrees]) =>
          worktrees.some((worktree) => worktree.id === wtId)
        )?.[0] ?? null
      await state.updateSettings({ uiLanguage: 'en', experimentalNativeChat: true })
      return found
    }, worktreeId)
    if (!repoId) {
      throw new Error('the seeded repo did not surface in the store')
    }
    await session.close(first.app)

    const profileDir = path.join(session.userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID)
    const seeded = await seedRealAgentDispatch(profileDir, { repoPath, repoId })
    const ledgerPath = path.join(profileDir, 'forge-inbox.db')

    const second = await session.launch()
    running = second.app
    await second.page.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('store unavailable')
      }
      if (store.getState().settings?.experimentalNativeChat !== true) {
        throw new Error('structured chat must stay enabled for a structured dispatch')
      }
      store.getState().openInboxPage()
    })

    const inbox = second.page.getByRole('main')
    await expect(inbox.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
    const item = inbox.getByText(seeded.itemTitle).first()
    await expect(item).toBeVisible({ timeout: 60_000 })

    await expect
      .poll(
        () => {
          const run = readLatestRun(ledgerPath)
          return run !== null && FINAL_RUN_STATES.has(run.state)
        },
        { timeout: 420_000, intervals: [2_000], message: 'the dispatched run never settled' }
      )
      .toBe(true)
    const run = readLatestRun(ledgerPath)
    if (!run) {
      throw new Error('the dispatched run disappeared while polling')
    }
    // A state and code only; the agent's own text stays in the app.
    console.log(
      `[real-agent] run ${run.id} ${run.state} error=${run.error ?? '-'} session=${run.sessionId ? 'recorded' : 'none'}`
    )

    await item.click()
    await expect(inbox.getByText(seeded.itemTitle).first()).toBeVisible()
    const shot = await capture(second.page, screenshots, `inbox-${run.state}`)
    await testInfo.attach(`inbox-${run.state}`, { path: shot, contentType: 'image/png' })

    // The launch, the turn and the settlement are the app's; a failure here is a real failure.
    expect(run.state, `the dispatch ended ${run.state} with ${run.error ?? 'no code'}`).toBe(
      'succeeded'
    )
    expect(run.sessionId).not.toBeNull()
    await expect(inbox.getByText('Succeeded').first()).toBeVisible()
    // A real turn ends with text; a "succeeded" run with no summary would mean nothing was read.
    const summary = run.result?.summary ?? ''
    expect(summary.trim().length, 'a settled dispatch must carry the turn text').toBeGreaterThan(0)
    console.log(`[real-agent] summary: ${summary.slice(0, 160).replaceAll('\n', ' ')}`)
    // The detail renders the same stored text; markdown syntax would not survive a raw match.
    const probe = (summary.split('\n').find((line) => line.trim().length > 0) ?? '')
      .replace(/[#*_`>[\]-]/g, '')
      .trim()
      .slice(0, 40)
    expect(probe.length, 'the summary must have readable text').toBeGreaterThan(0)
    await expect(inbox).toContainText(probe)

    // The design's continuation: the Inbox reopens the same session, not a fresh blank chat.
    await inbox.getByRole('button', { name: 'Open original session' }).click()
    // Leaving the Inbox is what proves the click navigated rather than matching the detail text.
    await expect(second.page.getByRole('heading', { name: 'Inbox', exact: true })).toHaveCount(0, {
      timeout: 30_000
    })
    await expect(second.page.getByText(probe).first()).toBeVisible({ timeout: 60_000 })
    const continued = await capture(second.page, screenshots, 'session-continued')
    await testInfo.attach('session-continued', { path: continued, contentType: 'image/png' })
  } finally {
    await session.dispose(running ?? undefined)
    rmSync(repoPath, { recursive: true, force: true })
  }
})

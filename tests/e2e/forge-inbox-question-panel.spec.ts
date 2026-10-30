import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { seedTaskAskedQuestion } from './helpers/forge-inbox-question-seed'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'

const ASKED = 'Merge before the release, or wait for the tests to go green?'

test.use({ screenshot: 'off' })

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

test('shows the question a task asked, and keeps it out of the host’s own wording', async () => {
  const testInfo = test.info()
  test.setTimeout(240_000)
  const screenshotsRoot = path.join(process.cwd(), 'validation-screenshots')
  mkdirSync(screenshotsRoot, { recursive: true })
  const screenshots = mkdtempSync(path.join(screenshotsRoot, 'project-event-question-'))
  const session = createRestartSession(testInfo, {
    DO_NOT_TRACK: '1',
    ORCA_TELEMETRY_DISABLED: '1'
  })
  // Why: the seeded item may be announced, and no test may raise a real OS notification.
  writeFileSync(
    path.join(session.userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(true), null, 2)}\n`
  )
  let running: ElectronApplication | null = null
  try {
    const first = await session.launch()
    await session.close(first.app)

    await seedTaskAskedQuestion(
      path.join(session.userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID),
      ASKED
    )

    const second = await session.launch()
    running = second.app
    await second.page.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('store unavailable')
      }
      if (store.getState().settings?.notifications.enabled !== false) {
        throw new Error('desktop notifications were not disabled in the isolated profile')
      }
      await store.getState().updateSettings({ uiLanguage: 'en' })
      store.getState().openInboxPage()
    })

    const inbox = second.page.getByRole('main')
    await expect(inbox.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
    await expect(inbox.getByText('Add thing').first()).toBeVisible({ timeout: 20_000 })
    await capture(second.page, screenshots, 'inbox-with-question')

    await inbox.getByText('Add thing').first().click()
    await expect(inbox.getByText('Needs your answer', { exact: true })).toBeVisible()
    // Why: the panel and the timeline both show the sentence the task asked, not the host copy.
    await expect(inbox.getByText(ASKED)).toHaveCount(2)
    await expect(inbox.getByText('Waiting for your answer.')).toBeVisible()
    const file = await capture(second.page, screenshots, 'question-panel')
    await testInfo.attach('question-panel', { path: file, contentType: 'image/png' })
  } finally {
    await session.dispose(running ?? undefined)
  }
})

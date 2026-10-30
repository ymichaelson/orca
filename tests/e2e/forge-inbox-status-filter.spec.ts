import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { seedProjectEventItems } from './helpers/forge-inbox-project-seed'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'

test.use({ screenshot: 'off' })
test.setTimeout(240_000)

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

test('narrows the Inbox to one handling state', async () => {
  const testInfo = test.info()
  const screenshotsRoot = path.join(process.cwd(), 'validation-screenshots')
  mkdirSync(screenshotsRoot, { recursive: true })
  const screenshots = mkdtempSync(path.join(screenshotsRoot, 'project-event-status-'))
  const session = createRestartSession(testInfo, {
    DO_NOT_TRACK: '1',
    ORCA_TELEMETRY_DISABLED: '1'
  })
  // Why: a seeded item may be announced, and no test may raise a real OS notification.
  writeFileSync(
    path.join(session.userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(true), null, 2)}\n`
  )
  let running: ElectronApplication | null = null
  try {
    const first = await session.launch()
    await session.close(first.app)

    const seeded = await seedProjectEventItems(
      path.join(session.userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID)
    )
    const [handled, failed, recorded] = seeded
    if (!handled || !failed || !recorded) {
      throw new Error('expected a handled, a failed and a recorded seed item')
    }

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
    for (const item of seeded) {
      await expect(inbox.getByText(item.title).first()).toBeVisible({ timeout: 20_000 })
    }
    const before = await capture(second.page, screenshots, 'inbox-all-states')

    const status = inbox.getByRole('combobox', { name: 'Status' })
    await expect(status).toBeVisible()
    await status.click()
    // Why: the option list renders in a portal outside <main>, so it is looked up on the page.
    await second.page.getByRole('option', { name: 'Handled', exact: true }).click()

    await expect(inbox.getByText(handled.title).first()).toBeVisible()
    for (const other of [failed, recorded]) {
      await expect(inbox.getByText(other.title)).toHaveCount(0)
    }
    const handledShot = await capture(second.page, screenshots, 'inbox-handled-only')

    await status.click()
    await second.page.getByRole('option', { name: 'Recorded', exact: true }).click()

    await expect(inbox.getByText(recorded.title).first()).toBeVisible()
    for (const other of [handled, failed]) {
      await expect(inbox.getByText(other.title)).toHaveCount(0)
    }
    const recordedShot = await capture(second.page, screenshots, 'inbox-recorded-only')

    await status.click()
    await second.page.getByRole('option', { name: 'Any status', exact: true }).click()
    for (const item of seeded) {
      await expect(inbox.getByText(item.title).first()).toBeVisible()
    }
    await testInfo.attach('inbox-all-states', { path: before, contentType: 'image/png' })
    await testInfo.attach('inbox-handled-only', { path: handledShot, contentType: 'image/png' })
    await testInfo.attach('inbox-recorded-only', {
      path: recordedShot,
      contentType: 'image/png'
    })
  } finally {
    await session.dispose(running ?? undefined)
  }
})

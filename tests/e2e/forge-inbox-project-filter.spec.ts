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

test('narrows the Inbox to one project the host names', async () => {
  const testInfo = test.info()
  const screenshotsRoot = path.join(process.cwd(), 'validation-screenshots')
  mkdirSync(screenshotsRoot, { recursive: true })
  const screenshots = mkdtempSync(path.join(screenshotsRoot, 'project-event-filter-'))
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
    const [demo, tool] = seeded
    if (!demo || !tool) {
      throw new Error('expected one seeded item per project')
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
    await expect(inbox.getByText(demo.title).first()).toBeVisible({ timeout: 20_000 })
    await expect(inbox.getByText(tool.title).first()).toBeVisible()
    const before = await capture(second.page, screenshots, 'inbox-two-projects')

    const project = inbox.getByRole('combobox', { name: 'Project' })
    await expect(project).toBeVisible()
    await project.click()
    // Why: the option list renders in a portal outside <main>, so it is looked up on the page.
    await expect(second.page.getByRole('option', { name: 'group/demo' })).toBeVisible()
    await second.page.getByRole('option', { name: 'other/tool' }).click()

    await expect(inbox.getByText(tool.title).first()).toBeVisible()
    await expect(inbox.getByText(demo.title)).toHaveCount(0)
    const narrowed = await capture(second.page, screenshots, 'inbox-one-project')

    await project.click()
    await second.page.getByRole('option', { name: 'All projects' }).click()
    await expect(inbox.getByText(demo.title).first()).toBeVisible()
    await testInfo.attach('inbox-two-projects', { path: before, contentType: 'image/png' })
    await testInfo.attach('inbox-one-project', { path: narrowed, contentType: 'image/png' })
  } finally {
    await session.dispose(running ?? undefined)
  }
})

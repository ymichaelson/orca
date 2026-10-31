import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import { ForgeInboxLedger } from '../../src/main/forge-inbox/forge-inbox-ledger'
import { FORGE_INBOX_LEDGER_FILE } from '../../src/main/forge-inbox/forge-inbox-host-startup'
import { seedDispatchRun } from '../../src/main/forge-inbox/forge-inbox-dispatch-confirmation-test-kit'
import { fakeStore } from '../../src/main/forge-inbox/forge-inbox-project-binding-test-fixture'

test.use({ screenshot: 'off' })
test.setTimeout(240_000)

const TITLE = 'Add merge recommendation'
const REASON = 'Docs only, safe to merge.'

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

/** A reviewed merge request whose run replied and advised merging, so the person has one action. */
function seedReviewedMergeRequest(profileDir: string): void {
  const ledger = ForgeInboxLedger.open(path.join(profileDir, FORGE_INBOX_LEDGER_FILE), {
    now: () => Date.now(),
    secretStore: fakeStore()
  })
  try {
    seedDispatchRun(ledger.ledgerContext(), {
      binding: {
        bindingId: 'binding-merge-recommendation',
        gitlabHost: 'gitlab.test',
        gitlabProjectId: 3
      },
      report: {
        status: 'claims',
        mode: 'remote-actions',
        claims: [{ kind: 'comment', target: { kind: 'merge_request', iid: 7 } }],
        recommendation: { action: 'merge', reason: REASON }
      },
      storedIid: 7,
      itemIid: 7,
      itemState: 'opened',
      title: TITLE
    })
  } finally {
    ledger.close()
  }
}

test('shows the recommendation and offers the merge a person can confirm', async () => {
  const testInfo = test.info()
  const screenshotsRoot = path.join(process.cwd(), 'validation-screenshots')
  mkdirSync(screenshotsRoot, { recursive: true })
  const screenshots = mkdtempSync(path.join(screenshotsRoot, 'project-event-recommendation-'))
  const session = createRestartSession(testInfo, {
    DO_NOT_TRACK: '1',
    ORCA_TELEMETRY_DISABLED: '1'
  })
  // Why: the seeded run is announced, and no test may raise a real OS notification.
  writeFileSync(
    path.join(session.userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(true), null, 2)}\n`
  )
  let running: ElectronApplication | null = null
  try {
    const first = await session.launch()
    await session.close(first.app)
    seedReviewedMergeRequest(
      path.join(session.userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID)
    )

    const second = await session.launch()
    running = second.app
    await second.page.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('store unavailable')
      }
      await store.getState().updateSettings({ uiLanguage: 'en' })
      store.getState().openInboxPage()
    })

    const inbox = second.page.getByRole('main')
    await expect(inbox.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
    const row = inbox.getByRole('button', { name: new RegExp(TITLE) })
    await expect(row).toBeVisible({ timeout: 20_000 })
    // The row names what the agent advised, so the list alone says what to do.
    await expect(row.getByText('Ready to merge')).toBeVisible()
    const listShot = await capture(second.page, screenshots, 'inbox-ready-to-merge')

    await row.click()
    await expect(inbox.getByText(REASON)).toBeVisible({ timeout: 20_000 })
    await expect(inbox.getByText('Replied')).toBeVisible()
    const detailShot = await capture(second.page, screenshots, 'inbox-recommendation')

    await inbox.getByRole('button', { name: 'Confirm merge' }).click()
    const dialog = second.page.getByRole('dialog')
    await expect(dialog.getByText('Merge merge request !7?')).toBeVisible()
    await expect(dialog.getByText(REASON)).toBeVisible()
    const dialogShot = await capture(second.page, screenshots, 'inbox-merge-confirm')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(second.page.getByRole('dialog')).toHaveCount(0)

    await testInfo.attach('inbox-ready-to-merge', { path: listShot, contentType: 'image/png' })
    await testInfo.attach('inbox-recommendation', { path: detailShot, contentType: 'image/png' })
    await testInfo.attach('inbox-merge-confirm', { path: dialogShot, contentType: 'image/png' })
  } finally {
    await session.dispose(running ?? undefined)
  }
})

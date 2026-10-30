import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'

test.use({
  disableDesktopNotifications: true,
  stubForgeClis: true,
  screenshot: 'off',
  orcaAppExtraEnv: {
    DO_NOT_TRACK: '1',
    ORCA_TELEMETRY_DISABLED: '1',
    ORCA_DIAGNOSTICS_DISABLED: '1'
  }
})

async function capture(
  page: Page,
  testInfo: TestInfo,
  directory: string,
  name: string
): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(directory, `${name}.png`)
    writeFileSync(file, Buffer.from(data, 'base64'), { flag: 'wx' })
    await testInfo.attach(name, { path: file, contentType: 'image/png' })
  } finally {
    await cdp.detach()
  }
}

test('shows Webhook settings, folder project settings, and the empty Inbox', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.setTimeout(180_000)
  const screenshotsRoot = path.join(process.cwd(), 'validation-screenshots')
  mkdirSync(screenshotsRoot, { recursive: true })
  const screenshots = mkdtempSync(path.join(screenshotsRoot, 'project-event-redesign-20261029-'))
  console.log(`CDP screenshots: ${screenshots}`)
  const folder = mkdtempSync(path.join(os.tmpdir(), 'orca-event-folder-'))
  registerPostElectronShutdownCleanup(async () => {
    rmSync(folder, { recursive: true, force: true })
  })

  const hasStubPath = await electronApp.evaluate(() => {
    const dir = process.env.ORCA_E2E_FORGE_STUB_DIR
    return Boolean(
      dir &&
      process.env.PATH?.split(':')[0] === dir &&
      process.env.SHELL === `${dir}/orca-test-shell`
    )
  })
  expect(hasStubPath).toBe(true)

  await orcaPage.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('store unavailable')
    }
    if (store.getState().settings?.notifications.enabled !== false) {
      throw new Error('desktop notifications were not disabled in the isolated profile')
    }
    await store.getState().updateSettings({ uiLanguage: 'en' })
    store.getState().openSettingsTarget({ pane: 'integrations', repoId: null })
    store.getState().openSettingsPage()
  })

  const webhook = orcaPage.locator('[data-settings-section="integrations-webhook"]')
  await expect(webhook.getByText('Disabled — not receiving')).toBeVisible()
  await expect(webhook.getByText(/The listener uses HTTP, not TLS/)).toBeVisible()
  const port = webhook.getByLabel('Exact listen port')
  const save = webhook.getByRole('button', { name: 'Save Webhook settings' })
  await port.fill('0')
  await expect(port).toHaveAttribute('aria-invalid', 'true')
  await expect(save).toBeDisabled()
  await port.fill('37421')
  await webhook.getByLabel('External base URL').fill('http://127.0.0.1:37421')
  await save.click()
  await expect(save).toBeDisabled()
  await expect(webhook.getByText('Disabled — not receiving')).toBeVisible()
  await webhook.getByText('Webhook', { exact: true }).evaluate((element) => {
    element.scrollIntoView({ block: 'start' })
  })
  await capture(orcaPage, testInfo, screenshots, 'webhook-disabled')

  const folderId = await orcaPage.evaluate(async (folderPath) => {
    const store = window.__store
    if (!store) {
      throw new Error('store unavailable')
    }
    const repo = await store.getState().addRepoPath(folderPath, 'folder')
    if (!repo) {
      throw new Error('folder was not added')
    }
    store.getState().openSettingsTarget({ pane: 'repo', repoId: repo.id })
    store.getState().openSettingsPage()
    return repo.id
  }, folder)
  await expect(orcaPage.getByText('Project event agent', { exact: true })).toBeVisible()
  const enableAgent = orcaPage.getByRole('switch', { name: 'Enable project event agent' })
  await expect(enableAgent).toBeVisible()
  await enableAgent.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await capture(orcaPage, testInfo, screenshots, 'folder-agent-settings')
  const association = orcaPage.getByPlaceholder('Paste a GitLab project URL or group/project')
  await expect(association).toBeVisible()
  await association.fill('group/example')
  await expect(orcaPage.getByRole('button', { name: 'Save GitLab project' })).toBeEnabled()
  await association.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await capture(orcaPage, testInfo, screenshots, 'folder-association-draft')

  await orcaPage.evaluate((repoId) => {
    const store = window.__store
    if (
      !store ||
      !store.getState().repos.some((repo) => repo.id === repoId && repo.kind === 'folder')
    ) {
      throw new Error('folder project missing')
    }
    store.getState().openInboxPage()
  }, folderId)
  const inbox = orcaPage.getByRole('main')
  await expect(inbox.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
  await expect(inbox.getByRole('combobox', { name: 'Inbox host' })).toBeVisible()
  await expect(
    inbox.getByText('No items yet. New project activity will appear here.')
  ).toBeVisible()
  await expect(
    inbox.getByText('Select an item to see its activity, runs and questions.')
  ).toBeVisible()
  await capture(orcaPage, testInfo, screenshots, 'inbox-empty')
})

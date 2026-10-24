import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Locator } from '@stablyai/playwright-test'
import { createForgeGitBlob } from '../../src/main/forge-inbox/forge-inbox-git-objects'
import { sha256OfContent } from '../../src/main/forge-inbox/forge-inbox-patch-draft'
import { expect, test } from './helpers/orca-app'

const PROJECT_ID = '42'
const IID = 7
const SHA = 'a'.repeat(40)
const INSTANCE_ID = 'primary'
const WEBHOOK_TOKEN = 'glpat-e2e-webhook-token'
const READ_TOKEN = 'glpat-e2e-read-token'
const TITLE = 'Add thing'
const DRAFT = 'Please add a test for the retry path.'
const BASE_FILE = 'old\n'
const CHANGED_FILE = 'new\n'
const CREATED_FILE = 'b\n'

const named = (username: string): { id: number; username: string; name: string } => ({
  id: 1,
  username,
  name: username
})

/** Serves the official REST shapes the owner host reads for one merge request. */
async function startFakeGitlab(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const send = (body: unknown, headers: Record<string, string> = {}): void => {
      response.writeHead(200, { 'content-type': 'application/json', ...headers })
      response.end(JSON.stringify(body))
    }
    if (pathname === `/api/v4/projects/${PROJECT_ID}/merge_requests/${IID}`) {
      send({
        iid: IID,
        state: 'opened',
        title: TITLE,
        sha: SHA,
        description: '',
        draft: false,
        target_branch: 'main',
        updated_at: '2026-10-01T12:00:00.000Z',
        diff_refs: { base_sha: SHA, head_sha: SHA, start_sha: SHA },
        author: named('alice'),
        reviewers: [named('me')],
        assignees: []
      })
      return
    }
    if (pathname === `/api/v4/projects/${PROJECT_ID}/merge_requests/${IID}/diffs`) {
      send([{ old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1 +1 @@', new_file: false }], {
        'x-next-page': ''
      })
      return
    }
    if (pathname === `/api/v4/projects/${PROJECT_ID}/merge_requests/${IID}/notes`) {
      send([], { 'x-next-page': '' })
      return
    }
    if (pathname === `/api/v4/projects/${PROJECT_ID}/repository/tree`) {
      send(
        [
          {
            id: createForgeGitBlob(BASE_FILE).oid,
            name: 'a.ts',
            type: 'blob',
            mode: '100644',
            path: 'src/a.ts'
          }
        ],
        { 'x-next-page': '' }
      )
      return
    }
    if (pathname === `/api/v4/projects/${PROJECT_ID}/repository/files/src%2Fa.ts/raw`) {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(BASE_FILE)
      return
    }
    if (pathname === `/api/v4/projects/${PROJECT_ID}/repository/branches/main`) {
      send({ name: 'main', commit: { id: SHA } })
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"message":"not found"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('fake GitLab did not bind')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('no port'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

function findLedgers(root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === 'forge-inbox.db') {
      found.push(path.join(entry.parentPath, entry.name))
    }
  }
  return found
}

function mergeRequestPayload(): unknown {
  return {
    object_kind: 'merge_request',
    user: named('alice'),
    project: { id: Number(PROJECT_ID) },
    object_attributes: {
      iid: IID,
      action: 'update',
      state: 'opened',
      last_commit: { id: SHA },
      updated_at: '2026-10-01 12:00:00 UTC'
    },
    reviewers: [named('me')]
  }
}

/** Posts one official Merge Request Hook to the loopback listener the host just bound. */
async function postHook(port: number): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/webhooks/gitlab/${INSTANCE_ID}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gitlab-token': WEBHOOK_TOKEN,
      'x-gitlab-event': 'Merge Request Hook',
      'webhook-id': `e2e-delivery-${IID}`
    },
    body: JSON.stringify(mergeRequestPayload())
  })
  return { status: response.status, body: await response.text() }
}

/** The feed only redraws on an explicit reload, so poll Refresh until the worker stores the item. */
async function refreshUntilVisible(refresh: Locator, item: Locator): Promise<void> {
  await expect(async () => {
    await refresh.click()
    await expect(item).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 60_000, intervals: [1_000] })
}

test('captures the inbox, item detail, settings and approval dialog from real host state', async ({
  electronApp,
  orcaPage
}) => {
  test.setTimeout(300_000)
  const directory = path.join(process.cwd(), 'validation-screenshots', 'forge-inbox-ui')
  mkdirSync(directory, { recursive: true })
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  async function screenshot(name: string): Promise<void> {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path.join(directory, `${name}.png`), Buffer.from(data, 'base64'))
  }
  /** Radix surfaces fade in; a capture taken mid-animation washes the content out. */
  async function settleAnimations(target: Locator): Promise<void> {
    await target.evaluate(async (element) => {
      await Promise.allSettled(
        element.getAnimations({ subtree: true }).map((animation) => animation.finished)
      )
    })
  }

  // Why: the sidebar has its own Settings button, so every inbox control is scoped to the page body.
  const inbox = orcaPage.getByRole('main')
  const checkbox = (text: string): ReturnType<typeof orcaPage.getByRole> =>
    inbox.locator('label').filter({ hasText: text }).getByRole('checkbox')

  const gitlab = await startFakeGitlab()
  const listenerPort = await freePort()
  try {
    await orcaPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      // Why: the spec asserts on English strings; the host may run a non-English locale.
      await store.getState().updateSettings({ uiLanguage: 'en' })
      store.getState().openInboxPage()
    })
    await expect(orcaPage.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
    await screenshot('01-inbox-empty')

    await inbox.getByRole('button', { name: 'Settings', exact: true }).click()
    await checkbox('Receive GitLab webhooks on this host').click()
    await orcaPage.locator('#forge-listener-port').fill(String(listenerPort))
    await orcaPage.locator('#forge-new-instance-id').fill(INSTANCE_ID)
    await orcaPage.locator('#forge-new-instance-url').fill(gitlab.url)
    await orcaPage
      .locator('section')
      .filter({ hasText: 'Add GitLab instance' })
      .getByRole('button', { name: 'Add', exact: true })
      .click()
    await orcaPage.locator(`#forge-usernames-${INSTANCE_ID}`).fill('me')
    await checkbox('Allow plaintext HTTP calls to the GitLab API').click()

    const repoName = await orcaPage.evaluate(() => {
      const repos = window.__store?.getState().repos ?? []
      return repos.find((repo) => (repo.connectionId ?? null) === null)?.displayName ?? ''
    })
    if (repoName === '') {
      throw new Error('no local repo to bind')
    }
    await orcaPage.locator(`#forge-new-repo-${INSTANCE_ID}`).click()
    await orcaPage.getByRole('option', { name: repoName }).click()
    await orcaPage.locator(`#forge-new-project-${INSTANCE_ID}`).fill(PROJECT_ID)
    await orcaPage
      .locator(`#forge-new-project-${INSTANCE_ID}`)
      .locator('xpath=../..')
      .getByRole('button', { name: 'Add', exact: true })
      .click()
    await checkbox('Enabled').click()
    await checkbox('Review requested').click()

    await orcaPage.getByRole('button', { name: 'Save settings', exact: true }).click()
    await expect(
      orcaPage.getByRole('button', { name: 'Save settings', exact: true })
    ).toBeDisabled()

    for (const [kind, secret] of [
      ['webhook', WEBHOOK_TOKEN],
      ['api-read', READ_TOKEN]
    ] as const) {
      const input = orcaPage.locator(`#forge-secret-${kind}`)
      const clear = input.locator('xpath=..').getByRole('button', { name: 'Clear', exact: true })
      const unprotected = orcaPage.getByRole('button', { name: 'Store it unencrypted anyway' })
      await input.fill(secret)
      await input.locator('xpath=..').getByRole('button', { name: 'Save', exact: true }).click()
      await expect(clear.or(unprotected)).toBeVisible({ timeout: 15_000 })
      if (await unprotected.isVisible()) {
        await unprotected.click()
      }
      await expect(clear).toBeVisible({ timeout: 15_000 })
    }
    await screenshot('02-settings-configured')

    await inbox.getByRole('button', { name: 'Back to inbox', exact: true }).click()
    const answer = await postHook(listenerPort)
    expect(answer.status, answer.body).toBe(202)

    const item = inbox.locator('ul button').filter({ hasText: TITLE })
    await refreshUntilVisible(inbox.getByRole('button', { name: 'Refresh', exact: true }), item)
    await screenshot('03-inbox-list')

    await item.click()
    await expect(inbox.getByRole('heading', { name: TITLE, exact: true })).toBeVisible()
    await expect(inbox.getByText('No analysis yet.', { exact: true })).toBeVisible()
    await screenshot('04-item-detail')

    // Seed the analysis run and its pending proposal the way a completed protected
    // analysis would, so the approval surface renders from real host data.
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const ledgerPath = findLedgers(userData)[0] ?? null
    if (ledgerPath === null) {
      throw new Error('forge inbox ledger was not created')
    }
    const db = new DatabaseSync(ledgerPath)
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      const itemRow = db
        .prepare('SELECT id, current_revision FROM items ORDER BY id DESC LIMIT 1')
        .get()
      if (itemRow === undefined) {
        throw new Error('forge inbox item row is missing')
      }
      const { id: itemId, current_revision: itemRevision } = itemRow
      if (typeof itemId !== 'number' || typeof itemRevision !== 'number') {
        throw new Error('forge inbox item row is not readable')
      }
      const policyRow = db
        .prepare('SELECT generation FROM policies WHERE instance_id = ? AND project_id = ?')
        .get(INSTANCE_ID, PROJECT_ID)
      if (policyRow === undefined || typeof policyRow.generation !== 'number') {
        throw new Error('forge inbox policy row is not readable')
      }
      const policyGeneration = policyRow.generation
      const now = Date.now()
      const run = db
        .prepare(
          `INSERT INTO runs (item_id, revision, state, generation, policy_generation,
             context_digest, analysis_kind, reason, error, session_id, result_json,
             created_at, updated_at)
           VALUES (?, ?, 'awaiting-approval', 1, ?, 'e2e-context', 'merge_request',
             'awaiting-approval', NULL, 'e2e-session', ?, ?, ?)`
        )
        .run(
          itemId,
          itemRevision,
          policyGeneration,
          JSON.stringify({
            summary: 'One gap in the change.',
            concerns: ['No retry test'],
            draft: DRAFT
          }),
          now,
          now
        )
      db.prepare(
        `INSERT INTO proposals (run_id, item_id, revision, policy_generation, status,
           body_json, created_at, resolved_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL)`
      ).run(
        Number(run.lastInsertRowid),
        itemId,
        itemRevision,
        policyGeneration,
        JSON.stringify({
          kind: 'comment',
          target: {
            instanceId: INSTANCE_ID,
            projectId: PROJECT_ID,
            kind: 'merge_request',
            iid: IID
          },
          headSha: SHA,
          body: DRAFT
        }),
        now
      )
    } finally {
      db.close()
    }

    // The feed never polls, so an explicit reload is what re-reads the detail after the seed.
    await inbox.getByRole('button', { name: 'Refresh', exact: true }).click()
    const review = inbox.getByRole('button', { name: 'Review', exact: true })
    await expect(review).toBeVisible({ timeout: 30_000 })
    await review.click()
    await expect(orcaPage.getByText('Review before sending', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText(DRAFT, { exact: true })).toBeVisible()
    const dialog = orcaPage.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await settleAnimations(dialog)
    await screenshot('05-approval-dialog')

    await orcaPage.getByRole('button', { name: 'Discuss', exact: true }).click()
    await expect(
      orcaPage.getByPlaceholder('Ask the analysis session about this proposal…')
    ).toBeVisible()
    await screenshot('06-discuss-session-entry')

    await orcaPage.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // Seed the exact patch a protected turn would propose, superseding the older pending comment
    // the way the host does, so approval runs through the real owner service and broker.
    const seed = new DatabaseSync(ledgerPath)
    let patchProposalId: number
    try {
      seed.exec('PRAGMA busy_timeout = 5000')
      const itemRow = seed
        .prepare('SELECT id, current_revision FROM items ORDER BY id DESC LIMIT 1')
        .get()
      if (itemRow === undefined) {
        throw new Error('forge inbox item row is missing')
      }
      const { id: itemId, current_revision: itemRevision } = itemRow
      if (typeof itemId !== 'number' || typeof itemRevision !== 'number') {
        throw new Error('forge inbox item row is not readable')
      }
      const policyRow = seed
        .prepare('SELECT generation FROM policies WHERE instance_id = ? AND project_id = ?')
        .get(INSTANCE_ID, PROJECT_ID)
      if (policyRow === undefined || typeof policyRow.generation !== 'number') {
        throw new Error('forge inbox policy row is not readable')
      }
      const now = Date.now()
      seed
        .prepare("UPDATE proposals SET status = 'stale', resolved_at = ? WHERE status = 'pending'")
        .run(now)
      const run = seed
        .prepare(
          `INSERT INTO runs (item_id, revision, state, generation, policy_generation,
             context_digest, analysis_kind, reason, error, session_id, result_json,
             created_at, updated_at)
           VALUES (?, ?, 'awaiting-approval', 2, ?, 'e2e-patch-context', 'merge_request',
             'awaiting-approval', NULL, 'e2e-session', ?, ?, ?)`
        )
        .run(
          itemId,
          itemRevision,
          policyRow.generation,
          JSON.stringify({ summary: 'Ready to apply.', concerns: [] }),
          now,
          now
        )
      const proposal = seed
        .prepare(
          `INSERT INTO proposals (run_id, item_id, revision, policy_generation, status,
             body_json, created_at, resolved_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL)`
        )
        .run(
          Number(run.lastInsertRowid),
          itemId,
          itemRevision,
          policyRow.generation,
          JSON.stringify({
            kind: 'patch',
            target: { instanceId: INSTANCE_ID, projectId: PROJECT_ID },
            baseSha: SHA,
            branch: 'main',
            operations: [
              {
                op: 'update',
                path: 'src/a.ts',
                baseSha256: sha256OfContent(BASE_FILE),
                content: CHANGED_FILE,
                resultSha256: sha256OfContent(CHANGED_FILE)
              },
              {
                op: 'create',
                path: 'src/b.ts',
                content: CREATED_FILE,
                resultSha256: sha256OfContent(CREATED_FILE)
              }
            ]
          }),
          now
        )
      patchProposalId = Number(proposal.lastInsertRowid)
    } finally {
      seed.close()
    }

    // Why: the dialog may keep the item selected after Escape; an explicit reload re-reads the detail.
    await inbox.getByRole('button', { name: 'Refresh', exact: true }).click()
    await inbox.locator('ul button').filter({ hasText: TITLE }).click()
    const patchReview = inbox.getByRole('button', { name: 'Review', exact: true })
    await expect(patchReview).toBeVisible({ timeout: 30_000 })
    await patchReview.click()
    await expect(
      orcaPage.getByRole('button', { name: 'Approve and apply changes', exact: true })
    ).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Show exact diff', exact: true }).click()
    const diff = dialog.locator('pre').filter({ hasText: '+new' })
    await expect(diff).toContainText('-old')
    await expect(diff).toContainText('+b')
    await expect(dialog).toContainText(`base ${SHA.slice(0, 12)}`)
    await settleAnimations(dialog)
    await screenshot('07-patch-exact-diff')

    await orcaPage.getByRole('button', { name: 'Approve and apply changes', exact: true }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })

    const verify = new DatabaseSync(ledgerPath, { readOnly: true })
    try {
      const receipt = verify
        .prepare('SELECT state FROM receipts WHERE proposal_id = ?')
        .get(patchProposalId)
      expect(receipt?.state).toBe('applied')
      const proposal = verify
        .prepare('SELECT status FROM proposals WHERE id = ?')
        .get(patchProposalId)
      expect(proposal?.status).toBe('consumed')
    } finally {
      verify.close()
    }

    const workRoot = path.join(path.dirname(ledgerPath), 'forge-inbox-patch-work')
    const tree = readdirSync(workRoot).find((name) => name.startsWith('forge-patch-'))
    if (tree === undefined) {
      throw new Error('the applied patch tree is missing')
    }
    expect(readFileSync(path.join(workRoot, tree, 'src/a.ts'), 'utf8')).toBe(CHANGED_FILE)
    expect(readFileSync(path.join(workRoot, tree, 'src/b.ts'), 'utf8')).toBe(CREATED_FILE)
    await screenshot('08-patch-applied')
  } finally {
    await gitlab.close()
  }
})

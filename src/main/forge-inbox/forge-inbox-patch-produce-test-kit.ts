import type { AgentSessionProtectedAnalysis } from '../../shared/agent-session-protected-analysis'
import {
  PROTECTED_CLAUDE_NATIVE_HASHES,
  PROTECTED_CLAUDE_PROFILE,
  protectedClaudePrivatePath
} from '../../shared/agent-session-protected-claude-launch'
import type { ForgeInboxConfigView } from '../../shared/forge-inbox-config'
import type { ForgeItem, ForgeRun } from '../../shared/forge-inbox-types'
import type { GitlabDiffFile, GitlabMergeRequest } from './forge-inbox-gitlab-api-schemas'
import { createForgeGitBlob } from './forge-inbox-git-objects'
import type { ForgePatchRequest } from './forge-inbox-patch-requests'
import type { ForgeProtectedSessionRecord } from './forge-inbox-protected-session-binding'
import { TURN_SESSION } from './forge-inbox-protected-turn-test-harness'

const INSTANCE_ID = 'gitlab-main'
const PROJECT_ID = '42'
const OWNER = '6f1c1f0e-2a5c-4b1e-9b0e-0a1b2c3d4e5f'
const RUN_ID = 3
const ITEM_ID = 7
const REQUEST_ID = 11
const PROPOSAL_ID = 55
const IID = 9
const HEAD = 'a'.repeat(40)
const HEAD_MOVED = 'c'.repeat(40)
const OLD_CONTENT = 'export const value = 0\n'
const NEW_CONTENT = 'export const value = 1\n'
const CANDIDATE = JSON.stringify({
  summary: 'Update the value',
  operations: [{ op: 'update', path: 'src/feature.ts', content: NEW_CONTENT }]
})

const SUBJECT: AgentSessionProtectedAnalysis = {
  ownerId: OWNER,
  instanceId: INSTANCE_ID,
  itemId: String(ITEM_ID),
  analysisKind: 'merge_request'
}

const CONFIG: ForgeInboxConfigView = {
  hostId: OWNER,
  configRevision: 1,
  schemaVersion: 1,
  config: {
    schemaVersion: 1,
    listener: {
      enabled: false,
      bindAddress: '127.0.0.1',
      port: 7421,
      acknowledgeExternalPlaintextHttp: false
    },
    instances: [
      {
        id: INSTANCE_ID,
        displayName: 'Main',
        baseUrl: 'https://gitlab.example.com',
        allowInsecureHttpApi: false,
        allowLegacyPayloadDigestDedupe: false,
        usernames: [],
        projects: [
          {
            projectId: PROJECT_ID,
            repoId: 'repo-1',
            rules: '',
            enabled: true,
            automaticAnalysis: false,
            events: {
              reviewRequests: false,
              participatingMergeRequestUpdates: false,
              pipelineFailures: false,
              issueMentions: false,
              issueAssignments: false
            },
            budgets: {
              timeoutSeconds: 600,
              maxInputTokens: 100_000,
              maxOutputTokens: 8_000,
              maxRunsPerHour: 12,
              maxConcurrentRuns: 1
            }
          }
        ]
      }
    ]
  },
  credentials: []
}

function request(overrides: Partial<ForgePatchRequest> = {}): ForgePatchRequest {
  return {
    id: REQUEST_ID,
    callerKey: 'client-1',
    operationId: 'op-1',
    requestDigest: 'd'.repeat(64),
    runId: RUN_ID,
    runGeneration: 1,
    sessionId: TURN_SESSION,
    itemId: ITEM_ID,
    revision: 2,
    policyGeneration: 1,
    configRevision: 1,
    invalidationGeneration: 0,
    state: 'in_progress',
    proposalId: null,
    reasonCode: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

const RUN: ForgeRun = {
  id: RUN_ID,
  itemId: ITEM_ID,
  revision: 2,
  state: 'succeeded',
  generation: 1,
  policyGeneration: 1,
  contextDigest: 'digest',
  analysisKind: 'merge_request',
  reason: 'review-requested',
  error: null,
  sessionId: TURN_SESSION,
  result: null,
  createdAt: 1,
  updatedAt: 1
}

const ITEM: ForgeItem = {
  id: ITEM_ID,
  hostId: OWNER,
  instanceId: INSTANCE_ID,
  projectId: PROJECT_ID,
  kind: 'merge_request',
  iid: IID,
  title: 'Add thing',
  state: 'opened',
  currentRevision: 2,
  activitySeq: 1,
  createdAt: 1,
  updatedAt: 1,
  unread: false
}

function protectedLaunch(privateRoot: string) {
  return {
    version: 1,
    profile: PROTECTED_CLAUDE_PROFILE,
    executable: {
      path: '/opt/claude/claude',
      platform: 'darwin-arm64',
      sha256: PROTECTED_CLAUDE_NATIVE_HASHES['darwin-arm64']
    },
    privateRoot,
    auth: {
      kind: 'saved-agent-env',
      settingsKey: 'claude',
      credentialKey: 'ANTHROPIC_API_KEY',
      baseUrl: 'https://api.anthropic.com'
    }
  }
}

function record(fence = 7): ForgeProtectedSessionRecord {
  const privateRoot = `/state/forge-protected-analysis/${TURN_SESSION}`
  return {
    schemaVersion: 3,
    provider: 'claude',
    accountHome: {
      variable: 'CLAUDE_CONFIG_DIR',
      path: protectedClaudePrivatePath(privateRoot, 'config')
    },
    options: { model: 'claude-protected-analysis' },
    protectedAnalysis: SUBJECT,
    protectedClaudeLaunch: protectedLaunch(privateRoot),
    lease: { runtimeFence: fence }
  }
}

function mergeRequest(overrides: Partial<GitlabMergeRequest> = {}): GitlabMergeRequest {
  return {
    iid: IID,
    state: 'opened',
    title: 'Add thing',
    description: '',
    target_branch: 'main',
    source_branch: 'feature/work',
    source_project_id: Number(PROJECT_ID),
    target_project_id: Number(PROJECT_ID),
    draft: false,
    sha: HEAD,
    diff_refs: { base_sha: 'b'.repeat(40), head_sha: HEAD, start_sha: 'b'.repeat(40) },
    author: 'alice',
    reviewers: [],
    assignees: [],
    updated_at: '2026-01-01T00:00:00Z',
    headPipeline: null,
    ...overrides
  }
}

function diff(overrides: Partial<GitlabDiffFile> = {}): GitlabDiffFile {
  return {
    old_path: 'src/feature.ts',
    new_path: 'src/feature.ts',
    diff: '',
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    generated_file: false,
    ...overrides
  }
}

const BLOB = createForgeGitBlob(OLD_CONTENT)

export {
  INSTANCE_ID,
  PROJECT_ID,
  OWNER,
  RUN_ID,
  ITEM_ID,
  REQUEST_ID,
  PROPOSAL_ID,
  IID,
  HEAD,
  HEAD_MOVED,
  OLD_CONTENT,
  NEW_CONTENT,
  CANDIDATE,
  SUBJECT,
  CONFIG,
  request,
  RUN,
  ITEM,
  protectedLaunch,
  record,
  mergeRequest,
  diff,
  BLOB
}

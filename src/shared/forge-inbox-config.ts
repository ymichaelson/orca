import { z } from 'zod'

export const FORGE_INBOX_CONFIG_SCHEMA_VERSION = 1
export const FORGE_INBOX_CONFIG_MAX_BYTES = 256 * 1024
export const FORGE_INBOX_DEFAULT_PORT = 7421
export const FORGE_CREDENTIAL_KINDS = ['webhook', 'api-read', 'api-write'] as const
export type ForgeCredentialKind = (typeof FORGE_CREDENTIAL_KINDS)[number]
export const FORGE_CREDENTIAL_MAX_BYTES = 8 * 1024

export const MAX_RULES_BYTES = 16 * 1024
const MAX_INSTANCES = 8
const MAX_PROJECTS_PER_INSTANCE = 256
const MAX_USERNAMES_PER_INSTANCE = 64
const LOOPBACK_BIND_ADDRESSES = ['127.0.0.1', '::1']

function hasControlCharacter(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })
}

const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !hasControlCharacter(value))

export function canonicalGitlabBaseUrl(value: string): string | null {
  if (/[\s?#\\]/.test(value) || hasControlCharacter(value)) {
    return null
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname === ''
  ) {
    return null
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

// `0.0.0.0` / `[::]` are bind addresses, not a base a remote GitLab can call back.
const UNSPECIFIED_RECEIVER_HOSTS = new Set(['0.0.0.0', '[::]', '::'])

export function canonicalReceiverBaseUrl(value: string): string | null {
  if (/[\s?#\\]/.test(value) || hasControlCharacter(value)) {
    return null
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname === '' ||
    UNSPECIFIED_RECEIVER_HOSTS.has(url.hostname.toLowerCase())
  ) {
    return null
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

const gitlabBaseUrlSchema = z
  .string()
  .max(2048)
  .transform((value, ctx) => {
    const canonical = canonicalGitlabBaseUrl(value)
    if (canonical === null) {
      ctx.addIssue({ code: 'custom', message: 'not a plain http(s) GitLab base URL' })
      return z.NEVER
    }
    return canonical
  })

export const forgeInboxProjectEventsSchema = z
  .strictObject({
    reviewRequests: z.boolean().default(false),
    participatingMergeRequestUpdates: z.boolean().default(false),
    pipelineFailures: z.boolean().default(false),
    issueMentions: z.boolean().default(false),
    issueAssignments: z.boolean().default(false)
  })
  .prefault({})

export const forgeInboxProjectBudgetsSchema = z
  .strictObject({
    timeoutSeconds: z.number().int().min(10).max(3600).default(600),
    maxInputTokens: z.number().int().min(1000).max(1_000_000).default(100_000),
    maxOutputTokens: z.number().int().min(100).max(200_000).default(8_000),
    maxRunsPerHour: z.number().int().min(1).max(600).default(12),
    maxConcurrentRuns: z.literal(1).default(1)
  })
  .prefault({})

const projectPolicySchema = z
  .strictObject({
    projectId: z
      .string()
      .regex(/^[1-9][0-9]{0,15}$/)
      .refine((id) => Number.isSafeInteger(Number(id))),
    repoId: label(200),
    workspaceId: label(200).optional(),
    agentId: label(100).optional(),
    model: label(200).optional(),
    rules: z
      .string()
      .default('')
      .refine((value) => !value.includes('\u0000'))
      .refine((value) => new TextEncoder().encode(value).length <= MAX_RULES_BYTES),
    enabled: z.boolean().default(false),
    automaticAnalysis: z.boolean().default(false),
    events: forgeInboxProjectEventsSchema,
    budgets: forgeInboxProjectBudgetsSchema
  })
  .superRefine((project, ctx) => {
    if (
      project.automaticAnalysis &&
      (project.agentId === undefined || project.model === undefined)
    ) {
      ctx.addIssue({ code: 'custom', message: 'automaticAnalysis needs an agentId and a model' })
    }
  })

function duplicates(values: string[]): boolean {
  return new Set(values).size !== values.length
}

const instanceSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    displayName: label(80),
    baseUrl: gitlabBaseUrlSchema,
    allowInsecureHttpApi: z.boolean().default(false),
    allowLegacyPayloadDigestDedupe: z.boolean().default(false),
    usernames: z
      .array(z.string().regex(/^[A-Za-z0-9_.-]{1,255}$/))
      .max(MAX_USERNAMES_PER_INSTANCE)
      .default([]),
    projects: z.array(projectPolicySchema).max(MAX_PROJECTS_PER_INSTANCE).default([])
  })
  .superRefine((instance, ctx) => {
    if (instance.baseUrl.startsWith('http:') && !instance.allowInsecureHttpApi) {
      ctx.addIssue({ code: 'custom', message: 'http GitLab API needs allowInsecureHttpApi' })
    }
    if (duplicates(instance.usernames.map((name) => name.toLowerCase()))) {
      ctx.addIssue({ code: 'custom', message: 'duplicate usernames' })
    }
    if (duplicates(instance.projects.map((project) => project.projectId))) {
      ctx.addIssue({ code: 'custom', message: 'duplicate project ids' })
    }
  })

const listenerSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    bindAddress: z
      .string()
      .refine((value) => z.ipv4().safeParse(value).success || z.ipv6().safeParse(value).success)
      .default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(FORGE_INBOX_DEFAULT_PORT),
    acknowledgeExternalPlaintextHttp: z.boolean().default(false)
  })
  .superRefine((listener, ctx) => {
    const loopback = LOOPBACK_BIND_ADDRESSES.includes(listener.bindAddress.toLowerCase())
    if (listener.enabled && !loopback && !listener.acknowledgeExternalPlaintextHttp) {
      ctx.addIssue({
        code: 'custom',
        message: 'an external bind needs acknowledgeExternalPlaintextHttp'
      })
    }
  })

export const forgeInboxConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(FORGE_INBOX_CONFIG_SCHEMA_VERSION),
    listener: listenerSchema.prefault({}),
    instances: z.array(instanceSchema).max(MAX_INSTANCES).default([])
  })
  .superRefine((config, ctx) => {
    if (duplicates(config.instances.map((instance) => instance.id))) {
      ctx.addIssue({ code: 'custom', message: 'duplicate instance ids' })
    }
  })

export type ForgeInboxConfig = z.infer<typeof forgeInboxConfigSchema>
export type ForgeInboxProjectPolicy = ForgeInboxConfig['instances'][number]['projects'][number]

export const DEFAULT_FORGE_INBOX_CONFIG: ForgeInboxConfig = {
  schemaVersion: FORGE_INBOX_CONFIG_SCHEMA_VERSION,
  listener: {
    enabled: false,
    bindAddress: '127.0.0.1',
    port: FORGE_INBOX_DEFAULT_PORT,
    acknowledgeExternalPlaintextHttp: false
  },
  instances: []
}

function withinSizeLimit(value: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= FORGE_INBOX_CONFIG_MAX_BYTES
  } catch {
    return false
  }
}

export type ForgeInboxConfigParse =
  | { ok: true; config: ForgeInboxConfig }
  | { ok: false; message: string }

/** Unknown fields and versions fail rather than being stripped, so a newer config is never overwritten. */
export function parseForgeInboxConfig(input: unknown): ForgeInboxConfigParse {
  if (!withinSizeLimit(input)) {
    return { ok: false, message: 'config is too large or not serializable' }
  }
  const parsed = forgeInboxConfigSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, message: `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}` }
  }
  if (!withinSizeLimit(parsed.data)) {
    return { ok: false, message: 'config is too large once defaults are applied' }
  }
  return { ok: true, config: parsed.data }
}

export type ForgeCredentialProtection = 'sealed' | 'plaintext'

/** Presence and protection only; secret bytes never leave the host-private ledger. */
export type ForgeCredentialStatus = {
  instanceId: string
  kind: ForgeCredentialKind
  protection: ForgeCredentialProtection
  gap: string | null
}

export type ForgeInboxConfigView = {
  hostId: string
  configRevision: number
  schemaVersion: typeof FORGE_INBOX_CONFIG_SCHEMA_VERSION
  config: ForgeInboxConfig
  credentials: ForgeCredentialStatus[]
}

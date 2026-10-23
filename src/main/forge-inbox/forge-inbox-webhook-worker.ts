import type { MainHttpClient } from '../network/http-client'
import { createGitlabApiReader } from './forge-inbox-gitlab-api-client'
import { ForgeCredentialUnavailableError } from './forge-inbox-credentials'
import { parseGitlabHook } from './forge-inbox-gitlab-hook-payload'
import { decideObservedCategory, planObservation } from './forge-inbox-gitlab-observation-plan'
import { pipelineFactsFor } from './forge-inbox-gitlab-pipeline-facts'
import { takeGitlabSnapshot } from './forge-inbox-gitlab-snapshot'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeWebhookDelivery } from './forge-inbox-webhook-queue'

export type ForgeWebhookWorkerLedger = Pick<
  ForgeInboxLedger,
  | 'hostId'
  | 'claimNextWebhookDelivery'
  | 'markWebhookDeliveryDone'
  | 'markWebhookDeliveryFailed'
  | 'markWebhookDeliveryNeedsAuth'
  | 'getConfig'
  | 'readSecret'
  | 'nowMs'
  | 'ingestObservation'
  | 'readProjectInvalidationGeneration'
>

export type ForgeWebhookWorkerDeps = {
  ledger: ForgeWebhookWorkerLedger
  http: Pick<MainHttpClient, 'fetch'>
  /** Stops claiming and abandons in-flight work; a claimed row keeps its durable lease. */
  signal?: AbortSignal
}

export type ForgeWebhookDrainResult = {
  processed: number
  done: number
  failed: number
  needsAuth: number
  retry: number
}

type Outcome =
  | { kind: 'done' }
  | { kind: 'needs-auth' }
  | { kind: 'terminal'; code: string }
  | { kind: 'retry'; code: string; retryAfterMs?: number }
  | { kind: 'cancelled' }

const DONE: Outcome = { kind: 'done' }
const CANCELLED: Outcome = { kind: 'cancelled' }

const API_RETRY_CODES: Record<string, string> = {
  'rate-limited': 'api-rate-limited',
  network: 'api-network',
  'bad-response': 'api-bad-response',
  'too-large': 'api-bad-response',
  'stale-config': 'stale-config',
  'head-moving': 'head-moving'
}

function apiFailureOutcome(failure: { code: string; retryAfterMs?: number }): Outcome {
  switch (failure.code) {
    case 'unauthorized':
    case 'forbidden':
    case 'no-credential':
      return { kind: 'needs-auth' }
    case 'not-found':
      return DONE
    default:
      return {
        kind: 'retry',
        code: API_RETRY_CODES[failure.code] ?? 'api-bad-response',
        ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs })
      }
  }
}

export const FORGE_WEBHOOK_MAX_DELIVERIES_PER_DRAIN = 100

/** One instance per owner; simultaneous drains share the same bounded, serial observation loop. */
export function createForgeWebhookWorker(deps: ForgeWebhookWorkerDeps) {
  const { ledger } = deps
  const { signal } = deps
  let inFlight: Promise<ForgeWebhookDrainResult> | null = null

  async function process(delivery: ForgeWebhookDelivery): Promise<Outcome> {
    const parsed = parseGitlabHook(delivery.eventKind, delivery.body)
    if (!parsed.ok) {
      return { kind: 'terminal', code: `hook-${parsed.reason}` }
    }
    const { configRevision, config } = ledger.getConfig()
    const instance = config.instances.find((candidate) => candidate.id === delivery.instanceId)
    const project = instance?.projects.find(
      (candidate) => candidate.projectId === delivery.projectId
    )
    if (!instance || !project?.enabled) {
      return DONE
    }
    const plan = planObservation(parsed.hook, instance.usernames, project.events)
    if (plan.action === 'skip') {
      return DONE
    }
    const invalidationGeneration = ledger.readProjectInvalidationGeneration({
      instanceId: instance.id,
      projectId: project.projectId
    })
    const reader = createGitlabApiReader(
      {
        http: deps.http,
        ...(signal ? { signal } : {}),
        readToken: () => {
          try {
            return ledger.readSecret(instance.id, 'api-read')?.secret ?? null
          } catch (error) {
            if (error instanceof ForgeCredentialUnavailableError) {
              return null
            }
            throw error
          }
        },
        readConfigRevision: () => ledger.getConfig().configRevision
      },
      {
        baseUrl: instance.baseUrl,
        projectId: project.projectId,
        expectedConfigRevision: configRevision
      }
    )
    const taken = await takeGitlabSnapshot(reader, plan.kind, plan.iid)
    if (signal?.aborted) {
      return CANCELLED
    }
    if (!taken.ok) {
      return apiFailureOutcome(taken)
    }
    const { snapshot } = taken
    const category = decideObservedCategory(
      plan,
      snapshot.subject,
      instance.usernames,
      project.events
    )
    if (category === null) {
      return DONE
    }
    if (category === 'unknown') {
      return { kind: 'retry', code: 'relevance-incomplete' }
    }
    const ci = pipelineFactsFor(parsed.hook, snapshot, plan.kind === 'merge_request')
    if (ci.kind === 'unavailable') {
      return { kind: 'retry', code: 'ci-unavailable' }
    }
    // A pipeline-failure trigger the API does not confirm is history, not attention.
    const passive =
      parsed.hook.kind === 'pipeline' && category === 'pipeline-failure' && !ci.observedFailed
    const observed = ledger.ingestObservation(
      {
        hostId: ledger.hostId,
        instanceId: instance.id,
        projectId: project.projectId,
        kind: plan.kind,
        iid: plan.iid,
        dedupeKey: `webhook:${delivery.dedupeKey}`,
        eventKind: `gitlab.${parsed.hook.kind}`,
        payload: {
          ...(passive ? {} : { category }),
          passive,
          completeness: snapshot.completeness,
          ...(ci.facts ? { pipeline: ci.facts } : {})
        },
        versionToken: snapshot.versionToken,
        title: snapshot.title,
        itemState: snapshot.itemState,
        ...(project.automaticAnalysis && !passive ? { queueRun: { reason: category } } : {})
      },
      configRevision,
      invalidationGeneration
    )
    return observed.ok ? DONE : { kind: 'retry', code: observed.reason }
  }

  function record(id: number, outcome: Outcome, result: ForgeWebhookDrainResult): void {
    switch (outcome.kind) {
      case 'cancelled':
        // A restart mid-delivery keeps the claim's attempt count; the lease already consumed one.
        return
      case 'done':
        if (ledger.markWebhookDeliveryDone(id).ok) {
          result.done += 1
        }
        return
      case 'needs-auth':
        if (ledger.markWebhookDeliveryNeedsAuth(id).ok) {
          result.needsAuth += 1
        }
        return
      case 'terminal':
        if (ledger.markWebhookDeliveryFailed(id, { code: outcome.code, terminal: true }).ok) {
          result.failed += 1
        }
        return
      case 'retry': {
        const marked = ledger.markWebhookDeliveryFailed(id, {
          code: outcome.code,
          nowMs: ledger.nowMs(),
          ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs })
        })
        // The attempt bound turns the last retry into a terminal failure.
        if (!marked.ok) {
          return
        }
        if (marked.state === 'failed') {
          result.failed += 1
        } else {
          result.retry += 1
        }
      }
    }
  }

  async function drain(): Promise<ForgeWebhookDrainResult> {
    const result = { processed: 0, done: 0, failed: 0, needsAuth: 0, retry: 0 }
    while (result.processed < FORGE_WEBHOOK_MAX_DELIVERIES_PER_DRAIN && !signal?.aborted) {
      const delivery = ledger.claimNextWebhookDelivery(ledger.nowMs())
      if (!delivery) {
        break
      }
      result.processed += 1
      try {
        record(delivery.id, await process(delivery), result)
      } catch {
        if (signal?.aborted) {
          break
        }
        // Only a fixed code is stored: exception text can carry payload content.
        record(delivery.id, { kind: 'retry', code: 'worker-error' }, result)
      }
    }
    return result
  }

  return {
    drainOnce(): Promise<ForgeWebhookDrainResult> {
      if (inFlight) {
        return inFlight
      }
      inFlight = drain()
      inFlight.then(
        () => {
          inFlight = null
        },
        () => {
          inFlight = null
        }
      )
      return inFlight
    }
  }
}

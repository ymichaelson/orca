// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForgeInboxDetail } from '../../src/renderer/src/components/forge-inbox/ForgeInboxDetail'
import { projectForgeItemDetail } from '../../src/main/forge-inbox/forge-inbox-read-projection'
import { getForgeItemDetail } from '../../src/main/forge-inbox/forge-inbox-queries'
import { readProjectEventActivity } from '../../src/main/forge-inbox/forge-inbox-project-event-activity'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from '../../src/main/forge-inbox/forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from '../../src/main/forge-inbox/forge-inbox-project-event-delivery'
import { drainProjectEventActions } from '../../src/main/forge-inbox/forge-inbox-project-event-action-drain'
import { observeProjectEventBindingHead } from '../../src/main/forge-inbox/forge-inbox-project-event-observation'
import {
  answerProjectEventQuestion,
  listProjectEventQuestions
} from '../../src/main/forge-inbox/forge-inbox-project-event-question-answer'
import {
  openProjectEventQuestionFixture,
  projectEventQuestionBody,
  projectEventQuestionDecision,
  type ProjectEventQuestionFixture
} from '../../src/main/forge-inbox/forge-inbox-project-event-question-test-kit'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from '../../src/main/forge-inbox/forge-inbox-webhook-queue'
import type { ForgeItemDetailView } from '../../src/shared/forge-inbox-rpc-types'

const LIMITS = FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS

describe('persisted Inbox auth provenance through the full detail', () => {
  let fixture: ProjectEventQuestionFixture
  let container: HTMLDivElement
  let root: Root
  const navigate = vi.fn()

  beforeEach(() => {
    fixture = openProjectEventQuestionFixture('inbox-auth-source-')
    navigate.mockClear()
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    fixture.close()
  })

  function admit(): number {
    const admitted = admitProjectEventDelivery(fixture.ctx, LIMITS, {
      bindingId: fixture.bindingId,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Merge Request Hook',
      dedupeKey: 'auth-source-delivery',
      correlation: { eventUuid: null, configUuid: null },
      body: projectEventQuestionBody()
    })
    if (!admitted.ok) {
      throw new Error('expected admitted delivery')
    }
    return admitted.deliveryId
  }

  function decide(deliveryId: number, action: 'ask_user' | 'fetch_context'): void {
    const claim = claimProjectEventDecision(fixture.ctx)
    if (claim === null) {
      throw new Error('expected model claim')
    }
    expect(
      decideProjectEventDelivery(
        fixture.ctx,
        deliveryId,
        projectEventQuestionDecision(action),
        claim
      ).ok
    ).toBe(true)
  }

  function detail(itemId: number): ForgeItemDetailView {
    const read = getForgeItemDetail(fixture.ctx, {}, itemId, 'client-1')
    if (read === null) {
      throw new Error('expected item detail')
    }
    return projectForgeItemDetail(read)
  }

  function render(view: ForgeItemDetailView): void {
    act(() =>
      root.render(
        createElement(ForgeInboxDetail, {
          detail: view,
          ownerHostId: null,
          ownerTarget: { kind: 'local' },
          questions: [],
          loading: false,
          error: null,
          onChanged: () => {},
          repairActions: { openHostSettings: navigate }
        })
      )
    )
  }

  async function providerFailure(): Promise<ForgeItemDetailView> {
    const deliveryId = admit()
    decide(deliveryId, 'ask_user')
    await drainProjectEventActions(fixture.ctx, { limits: LIMITS })
    const question = listProjectEventQuestions(fixture.ctx, { ownerHostId: fixture.ctx.hostId })[0]
    if (!question) {
      throw new Error('expected question with durable item identity')
    }
    expect(
      answerProjectEventQuestion(fixture.ctx, {
        ownerHostId: fixture.ctx.hostId,
        questionId: question.id,
        answer: 'Proceed'
      }).ok
    ).toBe(true)
    const claim = claimProjectEventDecision(fixture.ctx)
    if (claim === null) {
      throw new Error('expected redecision claim')
    }
    expect(
      decideProjectEventDelivery(
        fixture.ctx,
        deliveryId,
        { ok: false, code: 'unauthorized' },
        claim
      )
    ).toEqual({ ok: false, reason: 'decision-failed' })
    expect(
      fixture.ctx.db.prepare('SELECT id FROM project_event_decisions WHERE superseded = 0').all()
    ).toHaveLength(0)
    expect(fixture.ctx.db.prepare('SELECT id FROM project_event_decisions').all()).toHaveLength(1)
    return detail(question.itemId)
  }

  async function gitlabFailure(): Promise<ForgeItemDetailView> {
    const deliveryId = admit()
    decide(deliveryId, 'fetch_context')
    await drainProjectEventActions(fixture.ctx, {
      limits: LIMITS,
      observeContext: (claim) =>
        observeProjectEventBindingHead(fixture.ctx, claim, {
          exec: async () => {
            throw Object.assign(new Error('glab failed'), {
              stderr: 'glab: 401 Unauthorized (HTTP 401)'
            })
          }
        })
    })
    const action = fixture.ctx.db
      .prepare(
        'SELECT item_id, action_state, last_error_code FROM project_event_decisions WHERE superseded = 0'
      )
      .get()
    expect(action).toMatchObject({ action_state: 'blocked', last_error_code: 'unauthorized' })
    if (typeof action?.item_id !== 'number') {
      throw new Error('expected linked action item')
    }
    return detail(action.item_id)
  }

  it('projects a first-ever model auth failure as provider-owned without inventing a decision row', () => {
    const deliveryId = admit()
    const claim = claimProjectEventDecision(fixture.ctx)
    if (claim === null) {
      throw new Error('expected model claim')
    }
    decideProjectEventDelivery(fixture.ctx, deliveryId, { ok: false, code: 'unauthorized' }, claim)

    expect(fixture.ctx.db.prepare('SELECT id FROM project_event_decisions').all()).toHaveLength(0)
    expect(readProjectEventActivity(fixture.ctx, { repoId: 'repo-1' }).events[0]).toMatchObject({
      errorCode: 'unauthorized',
      errorSource: 'decision-provider'
    })
  })

  it('routes the actual failed redecision header to the decision provider, not GitLab', async () => {
    const view = await providerFailure()
    expect(view.handling).toMatchObject({
      state: 'failed',
      errorCode: 'unauthorized',
      errorSource: 'decision-provider'
    })
    render(view)

    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Open event decision settings'
    )
    expect(button).toBeDefined()
    act(() => button?.click())
    expect(navigate).toHaveBeenCalledWith({
      pane: 'agents',
      repoId: null,
      hostScope: { kind: 'local' },
      sectionId: 'agents-event-decision'
    })
    expect(container.querySelector('header')?.textContent).not.toContain('GitLab rejected')
  })

  it('routes actual GitLab context auth failures from both header and action timeline to GitLab', async () => {
    const view = await gitlabFailure()
    expect(view.handling).toMatchObject({ errorCode: 'unauthorized', errorSource: 'gitlab' })
    expect(view.timeline?.find((entry) => entry.kind === 'decision')).toMatchObject({
      errorCode: 'unauthorized',
      errorSource: 'gitlab'
    })
    render(view)

    const buttons = [...container.querySelectorAll('button')].filter(
      (candidate) => candidate.textContent === 'Open Integrations'
    )
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      act(() => button.click())
    }
    expect(navigate.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [
        {
          pane: 'integrations',
          repoId: null,
          hostScope: { kind: 'local' },
          sectionId: 'integrations-gitlab'
        }
      ])
    )
    expect(container.querySelector('header')?.textContent).toContain(
      'GitLab rejected the host credentials.'
    )
  })

  it('keeps old-host ambiguous auth and network messages neutral and does not guess repair destinations', async () => {
    const view = await gitlabFailure()
    const handling = view.handling
    if (handling === undefined) {
      throw new Error('expected handling')
    }
    const { errorSource: _source, ...oldHandling } = handling
    const timeline = view.timeline?.map((entry) => {
      if (entry.kind !== 'decision') {
        return entry
      }
      const { errorSource: _entrySource, ...oldEntry } = entry
      return oldEntry
    })
    render({ ...view, handling: oldHandling, timeline })

    expect(container.textContent).not.toContain('GitLab rejected')
    expect(container.querySelector('button')).toBeNull()
    render({ ...view, handling: { state: 'failed', errorCode: 'network' }, timeline: [] })
    expect(container.querySelector('header')?.textContent).not.toContain('GitLab')
    expect(container.querySelector('button')).toBeNull()
    for (const errorCode of ['unauthorized', 'network']) {
      render({
        ...view,
        handling: { state: 'failed', errorCode, errorSource: 'unknown' },
        timeline: []
      })
      expect(container.querySelector('header')?.textContent).not.toContain('GitLab')
      expect(container.querySelector('button')).toBeNull()
    }
  })
})

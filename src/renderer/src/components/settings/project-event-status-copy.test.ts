import { describe, expect, it } from 'vitest'
import {
  PROJECT_EVENT_ACTIVITY_OUTCOMES,
  type ProjectEventActivityOutcome
} from '../../../../shared/forge-inbox-project-event-activity'
import {
  PROJECT_EVENT_BINDING_FAILURE_CODES,
  PROJECT_EVENT_BINDING_FAILURE_PHASES,
  PROJECT_EVENT_BINDING_STATES
} from '../../../../shared/forge-inbox-project-binding'
import {
  activityKindCopy,
  activityOutcomeCopy,
  bindingActionFailureCopy,
  bindingFailureCopy,
  bindingFailurePhaseCopy,
  bindingStateCopy,
  secretProtectionCopy
} from './project-event-status-copy'

describe('project event status copy', () => {
  it('gives each activity outcome its own wording without calling an unknown state a failure', () => {
    const copy = new Map(
      PROJECT_EVENT_ACTIVITY_OUTCOMES.map((outcome: ProjectEventActivityOutcome) => [
        outcome,
        activityOutcomeCopy(outcome)
      ])
    )
    for (const outcome of PROJECT_EVENT_ACTIVITY_OUTCOMES) {
      expect(copy.get(outcome)).toBeTruthy()
    }
    expect(copy.get('unknown')).not.toBe(copy.get('failed'))
    expect(copy.get('waiting')).not.toBe(copy.get('done'))
    expect(copy.get('recorded')).toMatch(/no notification/i)
  })

  it('describes the connected state as a verified callback, not working analysis', () => {
    const connected = bindingStateCopy('connected')
    expect(connected).toMatch(/verified/i)
    expect(connected).not.toMatch(/automatic|analysis|agent/i)
    for (const state of PROJECT_EVENT_BINDING_STATES) {
      expect(bindingStateCopy(state)).toBeTruthy()
    }
    for (const phase of PROJECT_EVENT_BINDING_FAILURE_PHASES) {
      expect(bindingFailurePhaseCopy(phase)).toBeTruthy()
    }
  })

  it('maps every failure code to copy that never echoes the raw code', () => {
    for (const code of PROJECT_EVENT_BINDING_FAILURE_CODES) {
      const copy = bindingFailureCopy(code)
      expect(copy.length).toBeGreaterThan(0)
      expect(copy).not.toContain(code)
    }
  })

  it('falls back to generic copy for an unrecognized failure code', () => {
    const unknown = bindingFailureCopy('some-new-code')

    expect(unknown).toBe(bindingFailureCopy('also-unknown'))
    expect(unknown).not.toBe(bindingFailureCopy('network'))
    expect(unknown).not.toContain('some-new-code')
  })

  it('names every activity kind without showing the host enum', () => {
    for (const kind of ['issue', 'merge_request', 'pipeline', 'unknown'] as const) {
      expect(activityKindCopy(kind)).toBeTruthy()
      expect(activityKindCopy(kind)).not.toContain(kind)
    }
  })

  it('only calls a sealed secret encrypted', () => {
    expect(secretProtectionCopy('sealed')).toMatch(/encrypted/i)
    expect(secretProtectionCopy('plaintext')).toMatch(/unencrypted/i)
    expect(secretProtectionCopy(null)).not.toMatch(/encrypted/i)
    expect(secretProtectionCopy(null)).not.toBe(secretProtectionCopy('sealed'))
  })

  it('says a rejected rotation still applied the new secret', () => {
    const copy = bindingActionFailureCopy('rotate', 'event-configuration-rejected')

    expect(copy).toMatch(/secret was updated/i)
    expect(copy).not.toBe(bindingFailureCopy('event-configuration-rejected'))
  })

  it('tells an administrator how to allow only the callback address', () => {
    const copy = bindingFailureCopy('callback-blocked')

    expect(copy).toMatch(/GitLab administrator/)
    expect(copy).toMatch(/Outbound requests/)
  })
})

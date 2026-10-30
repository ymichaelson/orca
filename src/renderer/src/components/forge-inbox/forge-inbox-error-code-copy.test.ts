import { describe, expect, it } from 'vitest'
import { FORGE_DECISION_ERROR_CODES } from '../../../../shared/forge-inbox-error-codes'
import { forgeErrorCodeLabel } from './forge-inbox-error-code-copy'

describe('forge inbox error code copy', () => {
  const generic = forgeErrorCodeLabel('not-a-code-any-producer-writes')

  it.each(FORGE_DECISION_ERROR_CODES)('says something specific about %s', (code) => {
    expect(forgeErrorCodeLabel(code)).not.toBe(generic)
  })

  it('answers an unknown or inherited code with generic text that never echoes it', () => {
    for (const code of ['ECONNRESET at /home/me/token=abc', 'toString', '__proto__']) {
      const label = forgeErrorCodeLabel(code)
      expect(label).toBe(generic)
      expect(label).not.toContain(code)
    }
  })

  it('words run, event and service codes from their own domains', () => {
    const labels = ['agent-failure', 'missing-policy', 'rate-limited'].map((code) =>
      forgeErrorCodeLabel(code)
    )
    expect(new Set(labels).size).toBe(3)
    expect(labels).not.toContain(generic)
  })
})

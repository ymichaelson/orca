import { describe, expect, it, vi } from 'vitest'
import { decisionProbeResultText, decisionProviderDisclosure } from './project-event-decision-copy'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))

describe('decision provider disclosure', () => {
  it('says Jev sends event facts and rules to TypeSafe', () => {
    expect(decisionProviderDisclosure('jev', '')).toMatch(/TypeSafe/)
  })

  it.each(['http://127.0.0.1:8080/', 'http://localhost:8080', 'http://[::1]:8080'])(
    'keeps a loopback Laya service on the host (%s)',
    (baseUrl) => {
      expect(decisionProviderDisclosure('laya', baseUrl)).toMatch(/stay on this machine/)
    }
  )

  it('says a remote Laya service receives the data', () => {
    expect(decisionProviderDisclosure('laya', 'https://laya.example.test/')).toMatch(/sent there/)
  })

  it('does not promise locality before an address is configured', () => {
    expect(decisionProviderDisclosure('laya', '')).toMatch(/does not assume it stays local/)
  })
})

describe('decision probe result text', () => {
  it('names the provider and model that answered', () => {
    expect(
      decisionProbeResultText({
        ok: true,
        provider: 'laya',
        model: 'small',
        usedDefaultModel: false
      })
    ).toBe('Connected. Laya answered with model small.')
  })

  it('notes when the provider default model was used', () => {
    expect(
      decisionProbeResultText({
        ok: true,
        provider: 'jev',
        model: 'jev-latest',
        usedDefaultModel: true
      })
    ).toMatch(/provider default was used/)
  })

  it('maps every failure code to a distinct non-empty explanation', () => {
    const codes = [
      'invalid-config',
      'invalid-input',
      'request-too-large',
      'response-too-large',
      'bad-response',
      'unauthorized',
      'rate-limited',
      'overloaded',
      'aborted',
      'timeout',
      'network'
    ] as const
    const texts = new Map(codes.map((code) => [code, decisionProbeResultText({ ok: false, code })]))
    expect(texts.get('request-too-large')).toBe(texts.get('response-too-large'))
    expect(new Set(texts.values()).size).toBe(codes.length - 1)
    expect([...texts.values()].every((text) => text.trim().length > 0)).toBe(true)
  })
})

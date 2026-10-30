import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeProjectEventDecisionConnection } from './forge-inbox-decision-probe'

const KEY = 'probe-secret-CANARY'

function reply(status: number, body: string | null = null): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

const validAnswer = JSON.stringify({
  model: 'chooser-1',
  answers: {
    next_step: {
      type: 'choice',
      choice: 'record_only',
      confidence: 0.9,
      probabilities: {
        record_only: 0.9,
        notify: 0.02,
        wait: 0.02,
        fetch_context: 0.02,
        dispatch_agent: 0.02,
        ask_user: 0.02
      }
    }
  },
  usage: { input_tokens: 11, output_tokens: 2 }
})

const layaSettings = {
  provider: 'laya' as const,
  model: 'small',
  baseUrl: 'http://127.0.0.1:9000/api'
}

describe('decision connection probe', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends one bounded probe with the saved settings and key, never returning either', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => reply(200, validAnswer))
    const result = await probeProjectEventDecisionConnection({
      settings: layaSettings,
      apiKey: KEY,
      http: { fetch }
    })
    expect(result).toEqual({
      ok: true,
      provider: 'laya',
      model: 'chooser-1',
      usedDefaultModel: false
    })
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe('http://127.0.0.1:9000/api/v1/systemone')
    expect(init?.method).toBe('POST')
    expect(JSON.stringify(init?.headers)).toContain(KEY)
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'small',
      state: { event: { kind: 'connection-test' } }
    })
  })

  it('reports the provider default model when none is saved', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => reply(200, validAnswer))
    const result = await probeProjectEventDecisionConnection({
      settings: { provider: 'jev', model: '', baseUrl: '' },
      apiKey: KEY,
      http: { fetch }
    })
    expect(result).toMatchObject({ ok: true, usedDefaultModel: true })
    const [, init] = fetch.mock.calls[0] ?? []
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'jev-latest' })
  })

  it.each([
    [401, 'unauthorized'],
    [429, 'rate-limited'],
    [503, 'overloaded'],
    [400, 'bad-response']
  ] as const)('maps HTTP %s to %s without secret material', async (status, code) => {
    const fetch = vi.fn(async () => reply(status, JSON.stringify({ error: KEY })))
    const result = await probeProjectEventDecisionConnection({
      settings: layaSettings,
      apiKey: KEY,
      http: { fetch }
    })
    expect(result).toEqual({ ok: false, code })
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('refuses a model name carrying terminal escape sequences', async () => {
    const fetch = vi.fn(async () =>
      reply(200, JSON.stringify({ ...JSON.parse(validAnswer), model: 'chooser\u001b[31m' }))
    )
    const result = await probeProjectEventDecisionConnection({
      settings: layaSettings,
      apiKey: KEY,
      http: { fetch }
    })
    expect(result).toEqual({ ok: false, code: 'bad-response' })
  })

  it('ignores a leftover Laya address for Jev so the fixed endpoint still works', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => reply(200, validAnswer))
    const result = await probeProjectEventDecisionConnection({
      settings: { provider: 'jev', model: '', baseUrl: 'http://127.0.0.1:9000/api' },
      apiKey: KEY,
      http: { fetch }
    })
    expect(result).toMatchObject({ ok: true })
    const [url] = fetch.mock.calls[0] ?? []
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
  })

  it('returns invalid-config without a request when Laya has no address', async () => {
    const fetch = vi.fn(async () => reply(200, validAnswer))
    const result = await probeProjectEventDecisionConnection({
      settings: { provider: 'laya', model: '', baseUrl: '' },
      apiKey: KEY,
      http: { fetch }
    })
    expect(result).toEqual({ ok: false, code: 'invalid-config' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns invalid-config without a request when Jev has no key', async () => {
    const fetch = vi.fn(async () => reply(200, validAnswer))
    const result = await probeProjectEventDecisionConnection({
      settings: { provider: 'jev', model: '', baseUrl: '' },
      apiKey: '',
      http: { fetch }
    })
    expect(result).toEqual({ ok: false, code: 'invalid-config' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns aborted when the caller disconnects mid-flight', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          controller.abort()
        })
    )
    const result = await probeProjectEventDecisionConnection({
      settings: layaSettings,
      apiKey: KEY,
      http: { fetch },
      signal: controller.signal
    })
    expect(result).toEqual({ ok: false, code: 'aborted' })
  })
})

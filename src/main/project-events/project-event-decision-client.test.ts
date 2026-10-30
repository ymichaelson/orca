import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProjectEventDecisionClient } from './project-event-decision-client'
import { DEFAULT_PROJECT_EVENT_RULES } from '../../shared/project-event-default-rules'

const actions = ['record_only', 'notify', 'wait', 'fetch_context', 'dispatch_agent', 'ask_user']
const input = {
  rules: DEFAULT_PROJECT_EVENT_RULES,
  event: { kind: 'pipeline', status: 'running' },
  context: { awaitingPipeline: true }
}

function reply(choice = 'wait') {
  return {
    model: 'jev-1.14.0',
    answers: {
      next_step: {
        type: 'choice',
        choice,
        confidence: 0.8,
        probabilities: Object.fromEntries(
          actions.map((action) => [action, action === choice ? 1 : 0])
        )
      }
    },
    usage: { input_tokens: 616, output_tokens: 64 }
  }
}

function client(response: Response, provider: 'jev' | 'laya' = 'jev') {
  return createProjectEventDecisionClient({
    provider,
    ...(provider === 'laya' ? { baseUrl: 'http://127.0.0.1:8000' } : {}),
    apiKey: 'test-private-key',
    http: { fetch: async () => response }
  })
}

afterEach(() => vi.useRealTimers())

describe('project event decision client', () => {
  it('sends complete project rules and event facts and returns a typed decision', async () => {
    let request: unknown
    let endpoint: string | undefined
    let headers: Headers | undefined
    const decide = createProjectEventDecisionClient({
      provider: 'jev',
      apiKey: 'test-private-key',
      http: {
        fetch: async (url, init) => {
          endpoint = url
          headers = new Headers(init?.headers)
          request = JSON.parse(String(init?.body))
          expect(init?.redirect).toBe('error')
          expect(init?.credentials).toBe('omit')
          return Response.json(reply())
        }
      }
    })
    await expect(decide(input)).resolves.toMatchObject({
      ok: true,
      provider: 'jev',
      model: 'jev-1.14.0',
      action: 'wait',
      confidence: 0.8,
      usage: { inputTokens: 616, outputTokens: 64 }
    })
    expect(endpoint).toBe('https://api.typesafe.ai/v1/systemone')
    expect(headers?.get('authorization')).toBe('Bearer test-private-key')
    expect(request).toMatchObject({
      model: 'jev-latest',
      state: {
        project_rules: DEFAULT_PROJECT_EVENT_RULES,
        event: input.event,
        context: input.context
      },
      questions: { next_step: { type: 'choice' } }
    })
    expect(JSON.stringify(request)).not.toContain('test-private-key')
  })

  it('supports local Laya without credentials and preserves its own confidence', async () => {
    const decide = createProjectEventDecisionClient({
      provider: 'laya',
      baseUrl: 'http://127.0.0.1:8000/proxy',
      model: 'laya-multilingual',
      http: {
        fetch: async (url, init) => {
          expect(url).toBe('http://127.0.0.1:8000/proxy/v1/systemone')
          expect(new Headers(init?.headers).has('authorization')).toBe(false)
          const body: unknown = JSON.parse(String(init?.body))
          expect(body).toMatchObject({ model: 'laya-multilingual' })
          return Response.json({ ...reply('dispatch_agent'), routing: { checkpoint: 'ml' } })
        }
      }
    })
    await expect(decide(input)).resolves.toMatchObject({
      ok: true,
      provider: 'laya',
      action: 'dispatch_agent',
      confidence: 0.8
    })
  })

  it.each(actions)('accepts the supported action %s', async (action) => {
    await expect(client(Response.json(reply(action)))(input)).resolves.toMatchObject({
      ok: true,
      action
    })
  })

  it('rejects an invented action rather than dispatching it', async () => {
    await expect(client(Response.json(reply('run_shell')))(input)).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
  })

  it('rejects probabilities which do not describe the selected action', async () => {
    const body = reply()
    body.answers.next_step.probabilities = Object.fromEntries(actions.map((action) => [action, 0]))
    await expect(client(Response.json(body))(input)).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
  })

  it('rejects a selected action below a different action probability', async () => {
    const body = reply()
    body.answers.next_step.probabilities = {
      record_only: 1,
      notify: 0,
      wait: 0,
      fetch_context: 0,
      dispatch_agent: 0,
      ask_user: 0
    }
    await expect(client(Response.json(body))(input)).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
  })

  it('never silently truncates project rules to fit a request', async () => {
    const decide = createProjectEventDecisionClient({
      provider: 'jev',
      apiKey: 'key',
      http: {
        fetch: async () => {
          throw new Error('must not send')
        }
      }
    })
    await expect(decide({ ...input, rules: '规'.repeat(100_000) })).resolves.toEqual({
      ok: false,
      code: 'request-too-large'
    })
  })

  it('returns a value-free rate limit failure and does not retry or change provider', async () => {
    let requests = 0
    const decide = createProjectEventDecisionClient({
      provider: 'jev',
      apiKey: 'key',
      http: {
        fetch: async () => {
          requests += 1
          return new Response('sensitive provider error', {
            status: 429,
            headers: { 'retry-after': '2' }
          })
        }
      }
    })
    await expect(decide(input)).resolves.toEqual({
      ok: false,
      code: 'rate-limited',
      retryAfterMs: 2000
    })
    expect(requests).toBe(1)
  })

  it.each([401, 403])('maps HTTP %i without returning response bodies', async (status) => {
    await expect(client(new Response('sensitive', { status }))(input)).resolves.toEqual({
      ok: false,
      code: 'unauthorized'
    })
  })

  it('refuses a non-HTTPS Jev endpoint before sending a key', async () => {
    const decide = createProjectEventDecisionClient({
      provider: 'jev',
      baseUrl: 'http://example.test',
      apiKey: 'key',
      http: {
        fetch: async () => {
          throw new Error('must not send')
        }
      }
    })
    await expect(decide(input)).resolves.toEqual({ ok: false, code: 'invalid-config' })
  })

  it.each([
    'http://user:password@localhost:8000',
    'http://localhost:8000?token=secret',
    'http://localhost:8000/#x'
  ])('refuses credential-bearing or ambiguous base URL %s', async (baseUrl) => {
    const decide = createProjectEventDecisionClient({
      provider: 'laya',
      baseUrl,
      http: { fetch: async () => Response.json(reply()) }
    })
    await expect(decide(input)).resolves.toEqual({ ok: false, code: 'invalid-config' })
  })

  it('cancels an oversized provider response', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1))
      },
      cancel() {
        cancelled = true
      }
    })
    await expect(client(new Response(body))(input)).resolves.toEqual({
      ok: false,
      code: 'response-too-large'
    })
    expect(cancelled).toBe(true)
  })

  it('honors a pre-aborted caller without starting a request', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(client(Response.json(reply()))(input, controller.signal)).resolves.toEqual({
      ok: false,
      code: 'aborted'
    })
  })

  it('bounds a response body that never completes and cancels its stream', async () => {
    vi.useFakeTimers()
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
        }
      })
    )
    const decide = createProjectEventDecisionClient({
      provider: 'jev',
      apiKey: 'key',
      timeoutMs: 50,
      http: { fetch: async () => response }
    })
    const result = decide(input)
    await vi.advanceTimersByTimeAsync(51)
    await expect(result).resolves.toEqual({ ok: false, code: 'timeout' })
    expect(cancelled).toBe(true)
  })

  it('cancels an in-flight body when its caller aborts', async () => {
    const reading = Promise.withResolvers<void>()
    const controller = new AbortController()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve()
        },
        cancel() {
          cancelled = true
        }
      },
      { highWaterMark: 0 }
    )
    const pending = client(new Response(body))(input, controller.signal)
    await reading.promise
    controller.abort()
    await expect(pending).resolves.toEqual({ ok: false, code: 'aborted' })
    expect(cancelled).toBe(true)
  })

  it('rejects invalid UTF-8 instead of replacing malformed data', async () => {
    await expect(client(new Response(new Uint8Array([0xff])))(input)).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
  })

  it('cancels an oversized declared body before reading it', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      }
    })
    const response = new Response(body, { headers: { 'content-length': String(1024 * 1024 + 1) } })
    await expect(client(response)(input)).resolves.toEqual({
      ok: false,
      code: 'response-too-large'
    })
    expect(cancelled).toBe(true)
  })

  it.each(['', 'rules\u0000'])(
    'distinguishes invalid project rules from size limits',
    async (rules) => {
      await expect(client(Response.json(reply()))({ ...input, rules })).resolves.toEqual({
        ok: false,
        code: 'invalid-input'
      })
    }
  )

  it('rejects unserializable event facts without misreporting a size limit', async () => {
    await expect(client(Response.json(reply()))({ ...input, event: { id: 1n } })).resolves.toEqual({
      ok: false,
      code: 'invalid-input'
    })
  })

  it('redacts thrown transport errors', async () => {
    const decide = createProjectEventDecisionClient({
      provider: 'jev',
      apiKey: 'key',
      http: {
        fetch: async () => {
          throw new Error('key in upstream error')
        }
      }
    })
    await expect(decide(input)).resolves.toEqual({ ok: false, code: 'network' })
  })
})

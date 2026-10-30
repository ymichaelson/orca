import { describe, expect, it } from 'vitest'
import {
  projectEventDecisionForSource,
  projectEventDecisionSourceForSettings
} from './forge-inbox-decision-runtime'
import type { ProjectEventDecisionSettings } from '../../shared/project-event-decision-settings'

describe('project event decision settings source', () => {
  it('forwards owner cancellation through the settings adapter to HTTP', async () => {
    const abort = new AbortController()
    let transportSignal: AbortSignal | null | undefined
    const decide = projectEventDecisionForSource(
      {
        read: () => ({ settings: { provider: 'jev', model: '', baseUrl: '' }, apiKey: 'test-key' })
      },
      {
        fetch: async (_url, init) => {
          transportSignal = init?.signal
          abort.abort()
          return new Response('{}')
        }
      }
    )
    expect(await decide({ rules: 'Keep rules intact', event: {} }, abort.signal)).toEqual({
      ok: false,
      code: 'aborted'
    })
    expect(transportSignal?.aborted).toBe(true)
  })

  it('never sends Jev traffic to a leftover Laya address', async () => {
    const urls: string[] = []
    const decide = projectEventDecisionForSource(
      {
        read: () => ({
          settings: { provider: 'jev', model: '', baseUrl: 'https://laya.example.test/' },
          apiKey: 'test-key'
        })
      },
      {
        fetch: async (url) => {
          urls.push(url)
          return new Response('{}')
        }
      }
    )
    await decide({ rules: 'Keep rules intact', event: {} })
    expect(urls).toEqual(['https://api.typesafe.ai/v1/systemone'])
  })

  it('sends each provider only its own key after a provider switch', async () => {
    const requests: { url: string; authorization: string | null }[] = []
    const source = projectEventDecisionSourceForSettings(() => ({
      projectEventDecision: { provider: 'laya', model: '', baseUrl: 'https://laya.example.test/' },
      projectEventDecisionKey: 'jev-key'
    }))
    await projectEventDecisionForSource(source, {
      fetch: async (url, init) => {
        requests.push({
          url,
          authorization: new Headers(init?.headers).get('authorization')
        })
        return new Response('{}')
      }
    })({ rules: 'Keep rules intact', event: {} })
    expect(requests).toEqual([
      { url: 'https://laya.example.test/v1/systemone', authorization: null }
    ])
  })

  it('reads replacement settings and key removal without restarting', () => {
    const laya = {
      provider: 'laya' as const,
      model: 'local',
      baseUrl: 'https://local.example/api'
    }
    let current: {
      projectEventDecision?: ProjectEventDecisionSettings
      projectEventDecisionKey?: string
      projectEventDecisionLayaKey?: string
    } = { projectEventDecisionKey: 'jev-key', projectEventDecisionLayaKey: 'laya-key' }
    const source = projectEventDecisionSourceForSettings(() => current)
    expect(source.read().apiKey).toBe('jev-key')
    current = { projectEventDecision: laya, ...current }
    expect(source.read()).toEqual({ settings: laya, apiKey: 'laya-key' })
    current = { projectEventDecision: laya, projectEventDecisionKey: 'jev-key' }
    expect(source.read()).toEqual({ settings: laya, apiKey: '' })
    current = {}
    expect(source.read()).toEqual({
      settings: { provider: 'jev', model: '', baseUrl: '' },
      apiKey: ''
    })
  })
})

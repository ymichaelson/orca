import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeHookTestRepo } from '../hooks-test-fixtures'
import { RuntimeRepositoryHooksCommands } from './runtime-repository-hooks-commands'

describe('RuntimeRepositoryHooksCommands.getRepoHooks global defaults', () => {
  const globalDefaults = { setup: 'global setup', archive: '' }
  const sha256 = (content: string) => createHash('sha256').update(content).digest('hex')

  it('reports the global fallback as the effective hook and includes it in setupTrust', async () => {
    const commands = new RuntimeRepositoryHooksCommands({
      resolveRepo: async () => makeHookTestRepo(),
      getGlobalHookDefaults: () => globalDefaults
    })

    const result = await commands.getRepoHooks('test-id')

    expect(result.hooks).toEqual({ scripts: { setup: 'global setup' } })
    expect(result.setupTrust).toEqual({
      contentHash: sha256('global setup'),
      scriptContent: 'global setup'
    })
  })

  it('still prompts for the fallback under an explicit local-only policy', async () => {
    const commands = new RuntimeRepositoryHooksCommands({
      resolveRepo: async () =>
        makeHookTestRepo({
          commandSourcePolicy: 'local-only',
          scripts: { setup: '', archive: '' }
        }),
      getGlobalHookDefaults: () => globalDefaults
    })

    const result = await commands.getRepoHooks('test-id')

    expect(result.hooks).toEqual({ scripts: { setup: 'global setup' } })
    expect(result.setupTrust?.scriptContent).toBe('global setup')
  })

  it('omits setupTrust when a local script wins over the global default', async () => {
    const commands = new RuntimeRepositoryHooksCommands({
      resolveRepo: async () =>
        makeHookTestRepo({
          scripts: { setup: 'local setup', archive: '' }
        }),
      getGlobalHookDefaults: () => globalDefaults
    })

    const result = await commands.getRepoHooks('test-id')

    expect(result.hooks).toEqual({ scripts: { setup: 'local setup' } })
    expect(result.setupTrust).toBeUndefined()
  })

  it('omits setupTrust when no global default is configured', async () => {
    const commands = new RuntimeRepositoryHooksCommands({
      resolveRepo: async () => makeHookTestRepo()
    })

    const result = await commands.getRepoHooks('test-id')

    expect(result.hooks).toBeNull()
    expect(result.setupTrust).toBeUndefined()
  })

  it('survives an absent settings store (null-store guard) with no fallback', async () => {
    const commands = new RuntimeRepositoryHooksCommands({
      resolveRepo: async () => makeHookTestRepo(),
      getGlobalHookDefaults: () => undefined
    })

    const result = await commands.getRepoHooks('test-id')

    expect(result.hooks).toBeNull()
    expect(result.setupTrust).toBeUndefined()
    expect(result.globalHookDefaults).toBeUndefined()
  })
})

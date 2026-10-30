import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createForgeCliStubs } from './forge-cli-stubs'

it.skipIf(process.platform === 'win32')(
  'keeps forge stubs first through login shell hydration',
  () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'orca-forge-stubs-'))
    try {
      writeFileSync(path.join(home, '.bash_profile'), 'export PATH="/untrusted:$PATH"\n')
      writeFileSync(path.join(home, '.bashrc'), 'export PATH="/untrusted:$PATH"\n')
      const env: NodeJS.ProcessEnv = { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb' }
      createForgeCliStubs(home, env)
      if (!env.SHELL || !env.ORCA_E2E_FORGE_STUB_DIR) {
        throw new Error('missing stub environment')
      }
      const resolved = execFileSync(env.SHELL, ['-ilc', 'command -v gh; command -v glab'], {
        env,
        encoding: 'utf8'
      })
        .trim()
        .split('\n')
      expect(resolved).toEqual([
        path.join(env.ORCA_E2E_FORGE_STUB_DIR, 'gh'),
        path.join(env.ORCA_E2E_FORGE_STUB_DIR, 'glab')
      ])
      for (const cli of resolved) {
        expect(spawnSync(cli, ['--version'], { env }).status).toBe(0)
        expect(spawnSync(cli, ['auth', 'status'], { env }).status).toBe(1)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
)

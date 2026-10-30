import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function createForgeCliStubs(home: string, env: NodeJS.ProcessEnv): void {
  if (process.platform === 'win32') {
    throw new Error('stubForgeClis requires a POSIX shell')
  }
  const stubDir = path.join(home, 'forge-cli-stubs')
  mkdirSync(stubDir)
  for (const command of ['gh', 'glab']) {
    writeFileSync(
      path.join(stubDir, command),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "test stub\\n"; exit 0; fi\nexit 1\n',
      { mode: 0o700 }
    )
  }
  const shell = path.join(stubDir, 'orca-test-shell')
  writeFileSync(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', { mode: 0o700 })
  env.SHELL = shell
  env.PATH = `${stubDir}${path.delimiter}${env.PATH ?? ''}`
  env.ORCA_E2E_FORGE_STUB_DIR = stubDir
}

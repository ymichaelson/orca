import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  appendGitConfigEnv,
  readValidGitConfigEnvCount
} from '../../shared/git-credential-prompt-env'
import type { ForgeGitObject } from './forge-inbox-git-objects'

const INHERITED_ENV_KEYS = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR'
] as const

/**
 * A sealed environment: no user/system git config, no templates, no hooks, no prompt, and a
 * private HOME, so nothing from the developer's machine can change what this push does.
 */
export function sealedGitEnv(workspace: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  const home = join(workspace, 'home')
  env.HOME = home
  env.USERPROFILE = home
  env.XDG_CONFIG_HOME = home
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = join(workspace, 'gitconfig')
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ASKPASS = ''
  env.SSH_ASKPASS = ''
  env.GCM_INTERACTIVE = 'never'
  env.GIT_ATTR_NOSYSTEM = '1'
  env.GIT_CONFIG_COUNT = '1'
  env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
  env.GIT_CONFIG_VALUE_0 = join(workspace, 'hooks')
  return env
}

/** The auth header must land as a compound env value; a half-written protocol stays unauth. */
export function withRemoteConfig(
  env: NodeJS.ProcessEnv,
  config: readonly (readonly [string, string])[]
): NodeJS.ProcessEnv | null {
  if (config.length === 0) {
    return null
  }
  const next = appendGitConfigEnv(env, config)
  const expected = readValidGitConfigEnvCount(env)
  return expected !== null && readValidGitConfigEnvCount(next) === expected + config.length
    ? next
    : null
}

/** Git only reads a loose object when its path is the OID and the bytes are the zlib payload. */
export function writeLooseObject(gitDirectory: string, object: ForgeGitObject): void {
  const header = Buffer.from(`${object.type} ${object.content.length}\u0000`, 'utf8')
  const directory = join(gitDirectory, 'objects', object.oid.slice(0, 2))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(directory, object.oid.slice(2)),
    deflateSync(Buffer.concat([header, object.content])),
    {
      mode: 0o600
    }
  )
}

export function prepareWorkspace(workspace: string): void {
  mkdirSync(join(workspace, 'home'), { recursive: true, mode: 0o700 })
  mkdirSync(join(workspace, 'hooks'), { recursive: true, mode: 0o700 })
  mkdirSync(join(workspace, 'templates'), { recursive: true, mode: 0o700 })
  writeFileSync(join(workspace, 'gitconfig'), '', { mode: 0o600 })
}

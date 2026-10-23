import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  isProtectedClaudeAbsolutePath,
  PROTECTED_CLAUDE_NATIVE_HASHES,
  protectedClaudeLaunchSchema,
  type ProtectedClaudeLaunchV1
} from '../../shared/agent-session-protected-claude-launch'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

export type ProtectedClaudeExecutable = ProtectedClaudeLaunchV1['executable']
function unavailable(): never {
  throw new Error('protected_claude_native_unavailable')
}
export function protectedClaudeNativePlatform(): ProtectedClaudeExecutable['platform'] {
  const platform = `${process.platform}-${process.arch}`
  if (platform === 'darwin-arm64' || platform === 'linux-x64' || platform === 'win32-x64') {
    return platform
  }
  return unavailable()
}
export function admitProtectedClaudeNativeArtifact(input: {
  path: string
  canonicalPath: string
  platform: string
  format: string
  sha256: string
}): ProtectedClaudeExecutable {
  const executable = protectedClaudeLaunchSchema.shape.executable.safeParse({
    path: input.path,
    platform: input.platform,
    sha256: input.sha256
  })
  if (
    !executable.success ||
    input.path !== input.canonicalPath ||
    !isProtectedClaudeAbsolutePath(input.path)
  ) {
    return unavailable()
  }
  const format =
    input.platform === 'darwin-arm64' ? 'mach-o' : input.platform === 'linux-x64' ? 'elf' : 'pe'
  if (input.format !== format) {
    return unavailable()
  }
  return executable.data
}
export async function inspectProtectedClaudeNativeArtifact(
  path: string,
  platform: string = protectedClaudeNativePlatform()
): Promise<ProtectedClaudeExecutable> {
  try {
    if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path) {
      return unavailable()
    }
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size < 64 || metadata.size > 512 * 1024 * 1024) {
      return unavailable()
    }
    const handle = await open(path, 'r')
    let format = 'unknown'
    try {
      const header = Buffer.alloc(64)
      await handle.read(header, 0, header.length, 0)
      const magic = header.subarray(0, 4).toString('hex')
      if (magic === 'cffaedfe' || magic === 'feedfacf' || magic === 'cafebabe') {
        format = 'mach-o'
      }
      if (magic === '7f454c46') {
        format = 'elf'
      }
      if (header.subarray(0, 2).toString('ascii') === 'MZ') {
        format = 'pe'
      }
    } finally {
      await handle.close()
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk)
    }
    const after = await stat(path)
    if (
      metadata.size !== after.size ||
      metadata.mtimeMs !== after.mtimeMs ||
      metadata.ino !== after.ino ||
      (await realpath(path)) !== path
    ) {
      return unavailable()
    }
    return admitProtectedClaudeNativeArtifact({
      path,
      canonicalPath: path,
      platform,
      format,
      sha256: hash.digest('hex')
    })
  } catch {
    return unavailable()
  }
}

async function canonicalProspectivePath(path: string): Promise<string> {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return join(await realpath(current), ...missing.toReversed())
    } catch (error) {
      if (!isDefinitiveAbsence(error) || dirname(current) === current) {
        return unavailable()
      }
      missing.push(relative(dirname(current), current))
      current = dirname(current)
    }
  }
}
function overlaps(left: string, right: string): boolean {
  const a = process.platform === 'win32' ? left.toLowerCase() : left
  const b = process.platform === 'win32' ? right.toLowerCase() : right
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`)
}
export async function admitProtectedClaudePrivateRoot(input: {
  privateRoot: string
  scanRoots: readonly string[]
}): Promise<string> {
  try {
    const path = input.privateRoot
    if (
      !isAbsolute(path) ||
      resolve(path) !== path ||
      (await canonicalProspectivePath(path)) !== path
    ) {
      return unavailable()
    }
    for (const root of input.scanRoots) {
      if (!isAbsolute(root) || overlaps(path, await canonicalProspectivePath(resolve(root)))) {
        return unavailable()
      }
    }
    let current = path
    for (;;) {
      try {
        await lstat(join(current, '.git'))
        return unavailable()
      } catch (error) {
        if (!isDefinitiveAbsence(error)) {
          return unavailable()
        }
      }
      if (dirname(current) === current) {
        break
      }
      current = dirname(current)
    }
    return path
  } catch {
    return unavailable()
  }
}

export function protectedClaudeExecutableMatches(
  left: ProtectedClaudeExecutable,
  right: ProtectedClaudeExecutable
): boolean {
  return (
    left.path === right.path &&
    left.platform === right.platform &&
    left.sha256 === right.sha256 &&
    PROTECTED_CLAUDE_NATIVE_HASHES[left.platform] === left.sha256
  )
}

/** The home, config and work folders are real, owner-held directories nobody else can write. */
export async function protectedClaudePrivateDirectoriesAdmitted(
  privateRoot: string
): Promise<boolean> {
  try {
    for (const name of ['home', 'config', 'work']) {
      const entry = await lstat(join(privateRoot, name))
      if (!entry.isDirectory()) {
        return false
      }
      if (
        process.platform !== 'win32' &&
        (entry.uid !== process.getuid?.() || (entry.mode & 0o022) !== 0)
      ) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

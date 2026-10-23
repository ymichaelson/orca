import { createHash } from 'node:crypto'

export type ForgeGitObject = { type: 'blob' | 'tree' | 'commit'; oid: string; content: Buffer }

const SHA1 = /^[0-9a-f]{40}$/
const TIMEZONE = /^[+-]\d{4}$/

export function isForgeGitSha1(value: string): boolean {
  return SHA1.test(value)
}

export function forgeGitObjectOid(type: ForgeGitObject['type'], content: Buffer): string {
  const header = Buffer.from(`${type} ${content.length}\u0000`, 'utf8')
  return createHash('sha1').update(header).update(content).digest('hex')
}

function objectOf(type: ForgeGitObject['type'], content: Buffer): ForgeGitObject {
  return { type, oid: forgeGitObjectOid(type, content), content }
}

/** UTF-8 bytes; git stores byte counts, not character counts. */
export function createForgeGitBlob(content: string): ForgeGitObject {
  return objectOf('blob', Buffer.from(content, 'utf8'))
}

export type ForgeGitTreeEntry = { mode: '100644' | '100755' | '40000'; name: string; oid: string }

function entryNameProblem(name: string): boolean {
  if (name === '' || name === '.' || name === '..' || name.toLowerCase() === '.git') {
    return true
  }
  return Buffer.byteLength(name, 'utf8') > 255 || name.includes('/') || name.includes('\u0000')
}

/** Trees sort bytewise with a trailing slash on subtrees, which is what git compares on. */
function compareTreeNames(left: ForgeGitTreeEntry, right: ForgeGitTreeEntry): number {
  const leftName = left.mode === '40000' ? `${left.name}/` : left.name
  const rightName = right.mode === '40000' ? `${right.name}/` : right.name
  return Buffer.compare(Buffer.from(leftName, 'utf8'), Buffer.from(rightName, 'utf8'))
}

/** Null unless every entry is a plain blob or subtree with a well-formed name and object id. */
export function createForgeGitTree(entries: readonly ForgeGitTreeEntry[]): ForgeGitObject | null {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entryNameProblem(entry.name) || !SHA1.test(entry.oid)) {
      return null
    }
    const folded = entry.name.toLowerCase()
    if (seen.has(folded)) {
      return null
    }
    seen.add(folded)
  }
  const ordered = [...entries].sort(compareTreeNames)
  const chunks: Buffer[] = []
  for (const entry of ordered) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'))
    chunks.push(Buffer.from(entry.oid, 'hex'))
  }
  return objectOf('tree', Buffer.concat(chunks))
}

export type ForgeGitIdentity = {
  name: string
  email: string
  timeSeconds: number
  timezone: string
}

function identityProblem(identity: ForgeGitIdentity): boolean {
  return (
    identity.name === '' ||
    Buffer.byteLength(identity.name, 'utf8') > 128 ||
    // oxlint-disable-next-line no-control-regex -- identities cannot contain control bytes
    /[<>\u0000-\u001f\u007f]/.test(identity.name) ||
    Buffer.byteLength(identity.email, 'utf8') > 256 ||
    !/^[^\s<>]+@[^\s<>]+$/.test(identity.email) ||
    !Number.isSafeInteger(identity.timeSeconds) ||
    identity.timeSeconds < 0 ||
    !TIMEZONE.test(identity.timezone) ||
    Number(identity.timezone.slice(1, 3)) > 14 ||
    Number(identity.timezone.slice(3, 5)) > 59
  )
}

/**
 * Serializes exactly the headers git writes. Anything the caller cannot describe faithfully
 * (signatures, unknown headers) must be refused before reaching here, not approximated.
 */
export function createForgeGitCommit(input: {
  tree: string
  parents: readonly string[]
  author: ForgeGitIdentity
  committer: ForgeGitIdentity
  message: string
}): ForgeGitObject | null {
  if (
    !SHA1.test(input.tree) ||
    input.parents.length > 16 ||
    input.parents.some((parent) => !SHA1.test(parent)) ||
    identityProblem(input.author) ||
    identityProblem(input.committer) ||
    input.message.includes('\u0000') ||
    Buffer.byteLength(input.message, 'utf8') > 1024 * 1024
  ) {
    return null
  }
  const identityLine = (label: string, identity: ForgeGitIdentity): string =>
    `${label} ${identity.name} <${identity.email}> ${identity.timeSeconds} ${identity.timezone}\n`
  const header = [
    `tree ${input.tree}\n`,
    ...input.parents.map((parent) => `parent ${parent}\n`),
    identityLine('author', input.author),
    identityLine('committer', input.committer),
    '\n'
  ].join('')
  return objectOf('commit', Buffer.from(`${header}${input.message}`, 'utf8'))
}

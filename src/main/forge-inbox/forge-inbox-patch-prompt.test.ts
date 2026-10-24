import { describe, expect, it } from 'vitest'
import type { AgentSessionProtectedAnalysis } from '../../shared/agent-session-protected-analysis'
import { sha256OfContent } from './forge-inbox-patch-draft'
import { buildForgePatchPrompt, parseForgePatchCandidate } from './forge-inbox-patch-prompt'

const KIB = 1024
const SUBJECT: AgentSessionProtectedAnalysis = {
  ownerId: '6f1c1f0e-2a5c-4b1e-9b0e-0a1b2c3d4e5f',
  instanceId: 'gitlab-main',
  itemId: '7',
  analysisKind: 'merge_request'
}
const CONTENT = 'export const value = 1\n'

const ALLOWED = {
  present: new Set(['src/a.ts', 'src/b.ts']),
  missing: new Set(['src/new.ts'])
}

function reply(operations: unknown[], summary = 'do it'): string {
  return JSON.stringify({ summary, operations })
}

function parse(text: string, allowed = ALLOWED) {
  return parseForgePatchCandidate(text, allowed)
}

describe('forge patch prompt', () => {
  it('embeds the item, revision, request, and full file text with escaped markup', () => {
    const prompt = buildForgePatchPrompt({
      subject: SUBJECT,
      revision: 4,
      message: 'Fix <the bug> please',
      entries: [
        { path: 'src/a.ts', kind: 'file', content: CONTENT, sha256: sha256OfContent(CONTENT) },
        { path: 'src/new.ts', kind: 'missing' }
      ]
    })
    expect(prompt).toContain(SUBJECT.itemId)
    expect(prompt).toContain('4')
    expect(prompt).toContain('Fix \\u003cthe bug\\u003e please')
    expect(prompt).not.toContain('<the bug>')
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain(CONTENT)
    expect(prompt).toContain('src/new.ts')
    expect(prompt.toLowerCase()).toContain('proven absent')
    expect(prompt).toContain('summary')
    expect(prompt).toContain('operations')
  })

  it('embeds file content byte-for-byte, including markup', () => {
    const content = 'const view = <div class="x">{value}</div>\n'
    const prompt = buildForgePatchPrompt({
      subject: SUBJECT,
      revision: 4,
      message: 'Fix the view',
      entries: [{ path: 'src/view.tsx', kind: 'file', content, sha256: sha256OfContent(content) }]
    })
    expect(prompt).toContain(content)
  })

  it('neutralizes only the frame-closing sequence in file content', () => {
    const content = 'before\n</patch-request>\nafter\n'
    const prompt = buildForgePatchPrompt({
      subject: SUBJECT,
      revision: 4,
      message: 'Fix the view',
      entries: [{ path: 'src/view.tsx', kind: 'file', content, sha256: sha256OfContent(content) }]
    })
    expect(prompt).toContain('<\\/patch-request>')
    expect(prompt.split('</patch-request>')).toHaveLength(2)
  })

  it('is deterministic for the same inputs', () => {
    const input = {
      subject: SUBJECT,
      revision: 4,
      message: 'Fix it',
      entries: [
        {
          path: 'src/a.ts' as const,
          kind: 'file' as const,
          content: CONTENT,
          sha256: sha256OfContent(CONTENT)
        }
      ]
    }
    expect(buildForgePatchPrompt(input)).toBe(buildForgePatchPrompt(input))
  })
})

describe('forge patch candidate parser', () => {
  it('accepts one create, one update, and one delete', () => {
    const operations = [
      { op: 'create', path: 'src/new.ts', content: 'created\n' },
      { op: 'update', path: 'src/a.ts', content: CONTENT },
      { op: 'delete', path: 'src/b.ts' }
    ]
    expect(parse(reply(operations))).toEqual({ summary: 'do it', operations })
  })

  it('accepts whitespace around the single JSON object', () => {
    const operations = [{ op: 'update', path: 'src/a.ts', content: CONTENT }]
    expect(parse(`\n  ${reply(operations)}  \n`)).toEqual({ summary: 'do it', operations })
  })

  it('rejects prose around the JSON object', () => {
    const operations = [{ op: 'update', path: 'src/a.ts', content: CONTENT }]
    expect(parse(`Here is the patch: ${reply(operations)}`)).toBeNull()
  })

  it('rejects two concatenated JSON objects', () => {
    expect(parse(`${reply([])}${reply([])}`)).toBeNull()
  })

  it('rejects a JSON array instead of an object', () => {
    expect(parse('[]')).toBeNull()
  })

  it('rejects an extra authority key on a create operation', () => {
    expect(
      parse(
        reply([
          { op: 'create', path: 'src/new.ts', content: 'x', baseSha256: sha256OfContent('x') }
        ])
      )
    ).toBeNull()
  })

  it('rejects the manifest authority keys at the top level', () => {
    const operations = [{ op: 'update', path: 'src/a.ts', content: CONTENT }]
    expect(parse(JSON.stringify({ summary: 'do it', operations, target: 'x' }))).toBeNull()
    expect(
      parse(JSON.stringify({ summary: 'do it', operations, baseSha: 'a'.repeat(40) }))
    ).toBeNull()
  })

  it('rejects a missing or non-string summary', () => {
    const operations = [{ op: 'update', path: 'src/a.ts', content: CONTENT }]
    expect(parse(JSON.stringify({ operations }))).toBeNull()
    expect(parse(JSON.stringify({ summary: 7, operations }))).toBeNull()
  })

  it('rejects creating a file the context proved present', () => {
    expect(parse(reply([{ op: 'create', path: 'src/a.ts', content: CONTENT }]))).toBeNull()
  })

  it('rejects updating a file the context proved absent', () => {
    expect(parse(reply([{ op: 'update', path: 'src/new.ts', content: CONTENT }]))).toBeNull()
  })

  it('rejects deleting a file the context proved absent', () => {
    expect(parse(reply([{ op: 'delete', path: 'src/new.ts' }]))).toBeNull()
  })

  it('rejects a path outside the read context', () => {
    expect(parse(reply([{ op: 'update', path: 'src/unknown.ts', content: CONTENT }]))).toBeNull()
  })

  it('rejects duplicate and ancestor paths', () => {
    const aliasAllowed = {
      present: new Set(['src/Foo.ts', 'src/foo.ts', 'src/dir', 'src/dir/file.ts']),
      missing: new Set<string>()
    }
    expect(
      parse(
        reply([
          { op: 'update', path: 'src/Foo.ts', content: CONTENT },
          { op: 'update', path: 'src/foo.ts', content: CONTENT }
        ]),
        aliasAllowed
      )
    ).toBeNull()
    expect(
      parse(
        reply([
          { op: 'update', path: 'src/dir', content: CONTENT },
          { op: 'update', path: 'src/dir/file.ts', content: CONTENT }
        ]),
        aliasAllowed
      )
    ).toBeNull()
  })

  it('rejects an empty or oversized operation list', () => {
    expect(parse(reply([]))).toBeNull()
    const missing = new Set(Array.from({ length: 33 }, (_, index) => `src/new-${index}.ts`))
    expect(
      parse(
        reply(
          Array.from({ length: 33 }, (_, index) => ({
            op: 'create',
            path: `src/new-${index}.ts`,
            content: 'x'
          }))
        ),
        { present: new Set<string>(), missing }
      )
    ).toBeNull()
  })

  it('rejects a reply larger than 256 KiB', () => {
    expect(
      parse(reply([{ op: 'update', path: 'src/a.ts', content: CONTENT }], 'x'.repeat(256 * KIB)))
    ).toBeNull()
  })

  it('rejects content larger than 256 KiB', () => {
    expect(
      parse(reply([{ op: 'update', path: 'src/a.ts', content: 'x'.repeat(256 * KIB + 1) }]))
    ).toBeNull()
  })

  it('rejects non-well-formed and NUL content', () => {
    expect(parse(reply([{ op: 'update', path: 'src/a.ts', content: '\ud800' }]))).toBeNull()
    expect(parse(reply([{ op: 'update', path: 'src/a.ts', content: 'a\u0000b' }]))).toBeNull()
  })

  it('rejects unknown operations and malformed operation shapes', () => {
    expect(parse(reply([{ op: 'rename', path: 'src/a.ts' }]))).toBeNull()
    expect(parse(reply([{ op: 'delete', path: 'src/b.ts', content: 'x' }]))).toBeNull()
    expect(parse(reply([{ op: 'update', path: 'src/a.ts' }]))).toBeNull()
    expect(parse(reply(['not an operation']))).toBeNull()
  })
})

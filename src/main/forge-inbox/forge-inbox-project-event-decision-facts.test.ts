import { describe, expect, it } from 'vitest'
import { projectEventDecisionFacts } from './forge-inbox-project-event-decision-facts'

const factsOf = (value: Record<string, unknown>) =>
  projectEventDecisionFacts(new TextEncoder().encode(JSON.stringify(value)))

describe('project event decision facts', () => {
  it('does not report a push as missing facts its kind never carries', () => {
    expect(
      factsOf({
        object_kind: 'push',
        project: { id: 3 },
        ref: 'refs/heads/main',
        before: 'a'.repeat(40),
        after: 'b'.repeat(40),
        total_commits_count: 1
      }).missing
    ).toEqual([])
  })

  it('does not report a complete merge request as missing facts', () => {
    expect(
      factsOf({
        object_kind: 'merge_request',
        project: { id: 3 },
        merge_request: {
          id: 99,
          iid: 7,
          title: 'Add thing',
          state: 'opened',
          source_branch: 'feat',
          target_branch: 'main',
          description: 'Adds a thing.'
        },
        object_attributes: { action: 'update', last_commit: { id: 'c'.repeat(40) } }
      }).missing
    ).toEqual([])
  })

  it('reports only the facts its kind carries but the payload omits', () => {
    expect(
      factsOf({
        object_kind: 'merge_request',
        project: { id: 3 },
        merge_request: { id: 99, iid: 7, title: 'Add thing', state: 'opened' },
        object_attributes: { action: 'update' }
      }).missing
    ).toEqual(['sha', 'sourceBranch', 'targetBranch', 'text'])
  })

  it('does not report a note as missing the facts a note never carries', () => {
    expect(
      factsOf({
        object_kind: 'note',
        project: { id: 3 },
        merge_request: { id: 99, iid: 7 },
        object_attributes: { action: 'create', note: 'Looks good.' }
      }).missing
    ).toEqual([])
  })

  it('does not report a pipeline as missing the facts a pipeline never carries', () => {
    expect(
      factsOf({
        object_kind: 'pipeline',
        project: { id: 3 },
        object_attributes: { id: 11, status: 'running', ref: 'main', sha: 'd'.repeat(40) }
      }).missing
    ).toEqual([])
  })
})

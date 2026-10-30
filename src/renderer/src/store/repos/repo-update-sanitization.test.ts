import { describe, expect, it } from 'vitest'
import { sanitizeRepoUpdate } from './repo-update'

describe('renderer repo update sanitization of projectEventGitlabProject', () => {
  it('keeps the trimmed reference text', () => {
    expect(sanitizeRepoUpdate({ projectEventGitlabProject: '  group/demo  ' })).toEqual({
      projectEventGitlabProject: 'group/demo'
    })
  })

  it('drops blank text but preserves the null clear sentinel', () => {
    expect(sanitizeRepoUpdate({ projectEventGitlabProject: '   ' })).toEqual({})
    expect(sanitizeRepoUpdate({ projectEventGitlabProject: null })).toEqual({
      projectEventGitlabProject: null
    })
  })
})

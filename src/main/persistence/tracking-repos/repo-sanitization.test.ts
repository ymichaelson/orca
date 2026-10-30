import { describe, expect, it } from 'vitest'
import { sanitizeRepoUpdatesForPersistence } from './repo-sanitization'

describe('repo persistence sanitization of projectEventGitlabProject', () => {
  it('keeps the trimmed reference text', () => {
    expect(
      sanitizeRepoUpdatesForPersistence({
        projectEventGitlabProject: '  https://gitlab.test/group/demo  '
      })
    ).toEqual({ projectEventGitlabProject: 'https://gitlab.test/group/demo' })
  })

  it('drops blank text but preserves the null clear sentinel', () => {
    expect(sanitizeRepoUpdatesForPersistence({ projectEventGitlabProject: '   ' })).toEqual({})
    expect(sanitizeRepoUpdatesForPersistence({ projectEventGitlabProject: null })).toEqual({
      projectEventGitlabProject: null
    })
  })
})

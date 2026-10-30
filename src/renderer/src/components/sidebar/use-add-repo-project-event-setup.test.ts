// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import { useAddRepoProjectEventSetup } from './use-add-repo-project-event-setup'

const initial = useAppStore.getState()
const slug = vi.fn()

function localRepo(id: string): Repo {
  return {
    id,
    path: `/local/${id}`,
    displayName: id,
    badgeColor: '',
    addedAt: 0,
    kind: 'git',
    executionHostId: 'local'
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState(initial, true)
  useAppStore.setState({ repos: [localRepo('a'), localRepo('b')] })
  Object.assign(window, { api: { gl: { projectSlug: slug } } })
})
afterEach(() => {
  useAppStore.setState(initial, true)
})

describe('useAddRepoProjectEventSetup', () => {
  it('completes a repo without a host identity instead of guessing its owner by id', async () => {
    const completeGitRepoAdd = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useAddRepoProjectEventSetup({ completeGitRepoAdd, setStep: vi.fn() })
    )
    await act(() => result.current.onGitRepoReady('a', 'clone_url'))
    expect(slug).not.toHaveBeenCalled()
    expect(completeGitRepoAdd).toHaveBeenCalledTimes(1)
    expect(completeGitRepoAdd).toHaveBeenCalledWith('a', 'clone_url', undefined)
  })

  it('holds one add for setup and completes a concurrent add immediately, each exactly once', async () => {
    const completeGitRepoAdd = vi.fn().mockResolvedValue(undefined)
    const setStep = vi.fn()
    slug.mockResolvedValue({ host: 'gitlab.test', path: 'group/repo' })
    const { result } = renderHook(() =>
      useAddRepoProjectEventSetup({ completeGitRepoAdd, setStep })
    )
    await act(async () => {
      await Promise.all([
        result.current.onGitRepoReady('a', 'clone_url', 'local'),
        result.current.onGitRepoReady('b', 'clone_url', 'local')
      ])
    })
    expect(completeGitRepoAdd.mock.calls.map(([id]) => id)).toEqual(['b'])
    expect(result.current.step?.repo.id).toBe('a')
    await act(() => result.current.step!.onContinue())
    expect(completeGitRepoAdd.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b'])
  })

  it.each(['success', 'failure'] as const)(
    'does not let an old completion %s change a new session completion',
    async (outcome) => {
      let settleOld!: () => void
      let settleNew!: () => void
      const old = new Promise<void>((resolve, reject) => {
        settleOld = () => (outcome === 'success' ? resolve() : reject(new Error('old failure')))
      })
      const newer = new Promise<void>((resolve) => {
        settleNew = resolve
      })
      const completeGitRepoAdd = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(newer)
      slug.mockResolvedValue({ host: 'gitlab.test', path: 'group/repo' })
      const { result } = renderHook(() =>
        useAddRepoProjectEventSetup({ completeGitRepoAdd, setStep: vi.fn() })
      )
      await act(() => result.current.onGitRepoReady('a', 'clone_url', 'local'))
      let oldFinish!: Promise<boolean>
      act(() => {
        oldFinish = result.current.step!.onContinue()
      })
      act(() => result.current.reset())
      await act(() => result.current.onGitRepoReady('b', 'clone_url', 'local'))
      if (outcome === 'success') {
        await act(async () => {
          settleOld()
          await oldFinish
        })
      }
      let newFinish!: Promise<boolean>
      act(() => {
        newFinish = result.current.step!.onContinue()
      })
      if (outcome === 'failure') {
        await act(async () => {
          settleOld()
          await oldFinish
        })
        await act(() => result.current.step!.onContinue())
      }
      expect(completeGitRepoAdd.mock.calls.filter(([id]) => id === 'b')).toHaveLength(1)
      await act(async () => {
        settleNew()
        await newFinish
      })
    }
  )

  it('ignores a repeat continue from a step that is no longer showing', async () => {
    const completeGitRepoAdd = vi.fn().mockResolvedValue(undefined)
    slug.mockResolvedValue({ host: 'gitlab.test', path: 'group/repo' })
    const { result } = renderHook(() =>
      useAddRepoProjectEventSetup({ completeGitRepoAdd, setStep: vi.fn() })
    )
    await act(() =>
      result.current.onGitRepoBatchReady({
        repoIds: ['a', 'b'],
        source: 'clone_url',
        executionHostId: 'local'
      })
    )
    expect(result.current.step?.repo.id).toBe('a')
    const firstStep = result.current.step!
    let first: boolean | undefined
    let second: boolean | undefined
    await act(async () => {
      first = await firstStep.onContinue()
      second = await firstStep.onContinue()
    })
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(completeGitRepoAdd).not.toHaveBeenCalled()
    expect(result.current.step?.repo.id).toBe('b')
  })

  it('drops a detection the reset abandoned instead of completing on a later dialog session', async () => {
    const completeGitRepoAdd = vi.fn().mockResolvedValue(undefined)
    let releaseSlug!: (ref: unknown) => void
    slug.mockReturnValue(
      new Promise((resolve) => {
        releaseSlug = resolve
      })
    )
    const { result } = renderHook(() =>
      useAddRepoProjectEventSetup({ completeGitRepoAdd, setStep: vi.fn() })
    )
    let abandoned!: Promise<void>
    act(() => {
      abandoned = result.current.onGitRepoReady('a', 'clone_url', 'local')
    })
    act(() => result.current.reset())
    await act(async () => {
      releaseSlug({ host: 'gitlab.test', path: 'group/repo' })
      await abandoned
    })
    expect(completeGitRepoAdd).not.toHaveBeenCalled()
    expect(result.current.step).toBeNull()
    slug.mockResolvedValue({ host: 'gitlab.test', path: 'group/next' })
    await act(() => result.current.onGitRepoReady('b', 'clone_url', 'local'))
    expect(result.current.step?.repo.id).toBe('b')
  })
})

import { describe, expect, it } from 'vitest'
import { getDefaultNotificationSettings } from '../../../src/shared/notification-settings-defaults'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getE2ECompletedOnboardingProfile,
  writeE2ECompletedOnboardingProfile
} from './e2e-completed-onboarding-profile'

describe('completed onboarding profile', () => {
  it('writes the selected profile only to the supplied path', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'orca-onboarding-profile-'))
    try {
      const profilePath = path.join(directory, 'profile.json')
      writeE2ECompletedOnboardingProfile(profilePath, true)
      expect(readFileSync(profilePath, 'utf8')).toBe(
        `${JSON.stringify(getE2ECompletedOnboardingProfile(true), null, 2)}\n`
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not override notifications by default', () => {
    expect(getE2ECompletedOnboardingProfile().settings).not.toHaveProperty('notifications')
    expect(getE2ECompletedOnboardingProfile(false)).toEqual(getE2ECompletedOnboardingProfile())
  })

  it('disables desktop notifications only when opted in', () => {
    const profile = getE2ECompletedOnboardingProfile(true)
    expect(profile.settings.notifications).toEqual({
      ...getDefaultNotificationSettings(),
      enabled: false
    })
    const { notifications: _notifications, ...settings } = profile.settings
    expect(settings).toEqual(getE2ECompletedOnboardingProfile().settings)
    expect(profile.onboarding).toEqual(getE2ECompletedOnboardingProfile().onboarding)
    expect(profile.ui).toEqual(getE2ECompletedOnboardingProfile().ui)
  })
})

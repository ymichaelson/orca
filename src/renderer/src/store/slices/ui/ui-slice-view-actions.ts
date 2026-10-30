import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { rewindHistoryIndexPastView } from '../worktree-nav-history'

export function createUiViewActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  return {
    openActivityPage: () => {
      set((state) => ({
        activeView: 'activity',
        previousViewBeforeActivity:
          state.activeView === 'activity' ? state.previousViewBeforeActivity : state.activeView
      }))
    },
    closeActivityPage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeActivity
      })),
    selectedAutomationId: null,
    setSelectedAutomationId: (id) => set({ selectedAutomationId: id }),
    pendingAutomationRunNavigation: null,
    setPendingAutomationRunNavigation: (navigation) =>
      set({ pendingAutomationRunNavigation: navigation }),
    openAutomationsPage: () => {
      get().recordViewVisit('automations')
      set((state) => ({
        activeView: 'automations',
        previousViewBeforeAutomations:
          state.activeView === 'automations'
            ? state.previousViewBeforeAutomations
            : state.activeView
      }))
    },
    closeAutomationsPage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeAutomations,
        worktreeNavHistoryIndex: rewindHistoryIndexPastView(state, 'automations')
      })),
    openSpacePage: () => {
      get().recordFeatureInteraction?.('workspace-cleanup')
      if (typeof window !== 'undefined' && window.api?.workspaceSpace?.openWindow) {
        void window.api.workspaceSpace.openWindow()
        return
      }
      set((state) => ({
        activeView: 'space',
        previousViewBeforeSpace:
          state.activeView === 'space' ? state.previousViewBeforeSpace : state.activeView
      }))
    },
    closeSpacePage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeSpace
      })),
    openSkillsPage: () => {
      get().recordViewVisit('skills')
      set((state) => ({
        activeView: 'skills',
        previousViewBeforeSkills:
          state.activeView === 'skills' ? state.previousViewBeforeSkills : state.activeView
      }))
    },
    closeSkillsPage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeSkills,
        worktreeNavHistoryIndex: rewindHistoryIndexPastView(state, 'skills')
      })),
    openSkillShare: (shareId) => {
      get().recordViewVisit('skills')
      set((state) => ({
        activeView: 'skills',
        previousViewBeforeSkills:
          state.activeView === 'skills' ? state.previousViewBeforeSkills : state.activeView,
        pendingSkillShareId: shareId
      }))
    },
    clearPendingSkillShare: () => set({ pendingSkillShareId: null }),
    openSkillsSharedLinks: () => {
      get().recordViewVisit('skills')
      set((state) => ({
        activeView: 'skills',
        previousViewBeforeSkills:
          state.activeView === 'skills' ? state.previousViewBeforeSkills : state.activeView,
        pendingSkillsSharedView: true
      }))
    },
    clearPendingSkillsSharedView: () => set({ pendingSkillsSharedView: false }),
    openArtifactsPage: () => {
      get().recordViewVisit('artifacts')
      set((state) => ({
        activeView: 'artifacts',
        previousViewBeforeArtifacts:
          state.activeView === 'artifacts' ? state.previousViewBeforeArtifacts : state.activeView
      }))
    },
    closeArtifactsPage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeArtifacts,
        worktreeNavHistoryIndex: rewindHistoryIndexPastView(state, 'artifacts')
      })),
    openInboxPage: () => {
      get().recordViewVisit('inbox')
      set((state) => ({
        activeView: 'inbox',
        previousViewBeforeInbox:
          state.activeView === 'inbox' ? state.previousViewBeforeInbox : state.activeView,
        // Why: a fail-closed error belongs to one navigation, not to every later visit.
        forgeInboxRouteError: false
      }))
    },
    closeInboxPage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeInbox,
        worktreeNavHistoryIndex: rewindHistoryIndexPastView(state, 'inbox'),
        forgeInboxRouteError: false
      })),
    openInboxItem: (pending) => {
      get().recordViewVisit('inbox')
      set((state) => ({
        activeView: 'inbox',
        previousViewBeforeInbox:
          state.activeView === 'inbox' ? state.previousViewBeforeInbox : state.activeView,
        pendingInboxItem: pending,
        forgeInboxOwnerTarget: pending.target,
        forgeInboxRouteError: false
      }))
    },
    clearPendingInboxItem: () => set({ pendingInboxItem: null }),
    setForgeInboxOwnerTarget: (target) =>
      // Why: a pending banner click belongs to the owner it named, not to the owner now shown.
      set({ forgeInboxOwnerTarget: target, pendingInboxItem: null }),
    openUnroutableInboxItem: () => {
      get().recordViewVisit('inbox')
      set((state) => ({
        activeView: 'inbox',
        previousViewBeforeInbox:
          state.activeView === 'inbox' ? state.previousViewBeforeInbox : state.activeView,
        pendingInboxItem: null,
        forgeInboxRouteError: true
      }))
    },
    clearForgeInboxRouteError: () => set({ forgeInboxRouteError: false }),
    openMobilePage: () =>
      set((state) => ({
        activeView: 'mobile',
        previousViewBeforeMobile:
          state.activeView === 'mobile' ? state.previousViewBeforeMobile : state.activeView
      })),
    closeMobilePage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeMobile
      })),
    setNewWorkspaceDraft: (draft) => set({ newWorkspaceDraft: draft }),
    clearNewWorkspaceDraft: () => set({ newWorkspaceDraft: null })
  }
}

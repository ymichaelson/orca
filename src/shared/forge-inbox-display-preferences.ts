/** Which of a reader's archived items the Inbox list shows; the host applies it before paging. */
export const FORGE_INBOX_ARCHIVE_VIEW_VALUES = ['active', 'archived', 'all'] as const
export type ForgeInboxArchiveView = (typeof FORGE_INBOX_ARCHIVE_VIEW_VALUES)[number]

export const DEFAULT_FORGE_INBOX_ARCHIVE_VIEW: ForgeInboxArchiveView = 'active'

export function normalizeForgeInboxArchiveView(value: unknown): ForgeInboxArchiveView {
  return (
    FORGE_INBOX_ARCHIVE_VIEW_VALUES.find((candidate) => candidate === value) ??
    DEFAULT_FORGE_INBOX_ARCHIVE_VIEW
  )
}

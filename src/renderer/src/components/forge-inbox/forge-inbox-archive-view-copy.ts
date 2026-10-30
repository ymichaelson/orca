import { translate } from '@/i18n/i18n'
import type { ForgeInboxArchiveView } from '../../../../shared/forge-inbox-display-preferences'

export function archiveViewLabel(view: ForgeInboxArchiveView): string {
  switch (view) {
    case 'active':
      return translate('auto.components.forge-inbox.ForgeInboxList.viewActive', 'Active')
    case 'archived':
      return translate('auto.components.forge-inbox.ForgeInboxList.viewArchived', 'Archived')
    case 'all':
      return translate('auto.components.forge-inbox.ForgeInboxList.viewAll', 'All')
  }
}

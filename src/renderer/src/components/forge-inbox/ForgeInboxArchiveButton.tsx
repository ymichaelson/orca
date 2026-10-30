import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function ForgeInboxArchiveButton({
  itemId,
  archived,
  onSetArchived
}: {
  itemId: number
  archived: boolean
  onSetArchived: (itemId: number, archived: boolean) => Promise<boolean>
}): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  async function submit(): Promise<void> {
    if (pending) {
      return
    }
    setPending(true)
    setFailed(false)
    try {
      setFailed(!(await onSetArchived(itemId, !archived)))
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }
  return (
    <div>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={pending}
        onClick={() => void submit()}
      >
        {archived
          ? translate('auto.components.forge-inbox.ForgeInboxDetail.unarchive', 'Unarchive')
          : translate('auto.components.forge-inbox.ForgeInboxDetail.archive', 'Archive')}
      </Button>
      {failed ? (
        <p className="text-xs text-destructive">
          {translate('auto.components.forge-inbox.display.errorGeneric', 'Something went wrong.')}
        </p>
      ) : null}
    </div>
  )
}

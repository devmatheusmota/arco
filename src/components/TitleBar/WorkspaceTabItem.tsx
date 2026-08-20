import { Pin, TerminalSquare, X } from 'lucide-react'

import { useT } from '../../lib/i18n'
import type { WorkspaceTab } from '../../lib/types'
import styles from './TitleBar.module.css'

export type WorkspaceTabItemProps = {
  tab: WorkspaceTab
  active: boolean
  onActivate: () => void
  onClose: () => void
  onContextMenu: (position: { x: number; y: number }) => void
}

/** One workspace tab: a single project, with the pane count of that project. */
export function WorkspaceTabItem({
  tab,
  active,
  onActivate,
  onClose,
  onContextMenu,
}: WorkspaceTabItemProps) {
  const t = useT()
  const count = tab.snapshot.containers.reduce(
    (total, container) => total + container.paneIds.length,
    0,
  )
  return (
    <div
      className={`${styles.groupTab} ${active ? styles.groupTabActive : ''} ${
        tab.pinned ? styles.groupTabPinned : ''
      }`}
      onContextMenu={(event) => {
        event.preventDefault()
        onContextMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className={styles.groupTabMain}
        onClick={onActivate}
        title={tab.label}
      >
        {tab.pinned ? <Pin size={12} className={styles.groupTabPinIcon} /> : null}
        {tab.iconUrl ? (
          <img src={tab.iconUrl} alt="" className={styles.groupTabIcon} />
        ) : tab.kind === 'terminal' ? (
          <TerminalSquare size={14} className={styles.groupTabIconSvg} />
        ) : (
          <span className={styles.groupTabDot} style={{ background: tab.color ?? '#6ea8ff' }} />
        )}
        <span className={styles.groupTabName}>{tab.label}</span>
        <span className={styles.groupTabCount}>{count}</span>
      </button>
      <button
        type="button"
        className={styles.groupTabClose}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
        title={t('ui.titlebar.removeFromTopbar')}
        aria-label={t('ui.titlebar.removeNameFromTopbar', { name: tab.label })}
      >
        <X size={12} />
      </button>
    </div>
  )
}

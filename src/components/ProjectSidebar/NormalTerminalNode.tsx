import { useDraggable } from '@dnd-kit/core'
import { FileText, MoreHorizontal } from 'lucide-react'

import { useRelativeTick } from '../../hooks/useRelativeTick'
import { useSidebarChatTitle } from '../../hooks/useSidebarChatTitle'
import { formatRelativeTimestamp } from '../../lib/greeting'
import { useT } from '../../lib/i18n'
import { sessionDisplayLabel } from '../../lib/sessionLabel'
import { type AgentType, type Project, type Terminal } from '../../lib/types'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { Favicon } from '../Favicon'
import { DotmCircular2 } from '../ui/dotm-circular-2'
import { AgentMonogram } from './AgentMonogram'
import styles from './NormalProjectSidebar.module.css'

export type NormalTerminalNodeProps = {
  project: Project
  terminal: Terminal
  selected: boolean
  focused?: boolean
  onClick: () => void
  onDoubleClick: () => void
  onMenu: (e: React.MouseEvent) => void
}

export function NormalTerminalNode({
  project,
  terminal,
  selected,
  focused,
  onClick,
  onDoubleClick,
  onMenu,
}: NormalTerminalNodeProps) {
  const t = useT()
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `term:${project.id}:${terminal.id}`,
  })

  const activeTab = terminal.tabs.find((tab) => tab.id === terminal.activeTabId) ?? terminal.tabs[0]
  const chatTitle = useSidebarChatTitle(activeTab)
  const displayName = sessionDisplayLabel(terminal, chatTitle)
  const uniqueTypes = Array.from(new Set(terminal.tabs.map((tab) => tab.type))) as AgentType[]
  const orderedTypes =
    activeTab && uniqueTypes.length > 1
      ? [activeTab.type, ...uniqueTypes.filter((type) => type !== activeTab.type)]
      : uniqueTypes
  const hasUnreadCompletion = terminal.tabs.some((tab) => tab.completionUnread)
  const isWorking = useTerminalsStore((state) =>
    terminal.tabs.some((tab) => tab.ptyId && state.byPtyId[tab.ptyId]?.status === 'working'),
  )

  // `lastUsedAt` only moves when the user does something — a session running on
  // its own for an hour never advances it — so the real signal is the PTY's own
  // I/O clock, the same pair `useResourceSupervisor` already relies on.
  //
  // Reading `lastIoAt` straight would repaint every row on every chunk of
  // output, and the sidebar is on the typing path. Bucketing it to the minute
  // the label is drawn at means the selector returns the same number between
  // ticks and Zustand skips the render entirely.
  const activityBucket = useTerminalsStore((state) => {
    let latest = 0
    for (const tab of terminal.tabs) {
      if (!tab.ptyId) continue
      const io = state.byPtyId[tab.ptyId]?.lastIoAt ?? 0
      if (io > latest) latest = io
    }
    return Math.floor(latest / 60_000)
  })
  useRelativeTick()
  const lastActivityAt = Math.max(activityBucket * 60_000, terminal.lastUsedAt ?? 0)
  const relativeTime = lastActivityAt ? formatRelativeTimestamp(lastActivityAt) : ''

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`${styles.terminalRow} ${focused ? styles.terminalFocused : ''} ${
        !selected ? styles.terminalHidden : ''
      } ${terminal.disabled ? styles.terminalDisabled : ''} ${isDragging ? styles.dragging : ''}`}
      onClick={() => onClick()}
      onDoubleClick={(event) => {
        event.stopPropagation()
        onDoubleClick()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onMenu(e)
      }}
      title={terminal.url || terminal.filePath || displayName}
    >
      <span className={styles.agentStack}>
        {terminal.kind === 'web' ? (
          <span className={styles.agentIcon}>
            <Favicon url={terminal.url ?? ''} size={14} />
          </span>
        ) : terminal.kind && terminal.kind !== 'terminal' ? (
          <span className={styles.agentIcon}>
            <FileText size={14} />
          </span>
        ) : (
          orderedTypes.map((type, i) => (
            <span
              key={type}
              className={styles.agentIcon}
              style={{ marginLeft: i === 0 ? 0 : 2, zIndex: orderedTypes.length - i }}
            >
              <AgentMonogram type={type} />
            </span>
          ))
        )}
      </span>
      <span className={styles.terminalName}>{displayName}</span>
      {terminal.tabs.length > 1 ? (
        <span className={styles.tabCount}>{terminal.tabs.length}</span>
      ) : null}
      {/* The working indicator says "now" better than any timestamp, so the two
          share the slot instead of competing for the width. */}
      {relativeTime && !isWorking ? (
        <span className={styles.rowTime} title={t('ui.terminal.lastActivity')}>
          {relativeTime}
        </span>
      ) : null}
      <span
        className={`${styles.rowEndSlot} ${isWorking || hasUnreadCompletion ? styles.rowEndSlotActive : ''}`}
      >
        {isWorking ? (
          <DotmCircular2
            size={14}
            dotSize={2}
            cellPadding={1}
            speed={1.2}
            bloom
            ariaLabel={t('ui.terminal.working')}
            className={`${styles.terminalLoading} ${styles.rowStatusIndicator}`}
          />
        ) : hasUnreadCompletion ? (
          <span
            className={`${styles.doneBadge} ${styles.rowStatusIndicator}`}
            title={t('ui.terminal.responseReady')}
          >
            !
          </span>
        ) : null}
        <button
          type="button"
          className={`${styles.rowHoverBtn} ${styles.rowEndAction}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onMenu(event)
          }}
          title={t('ui.terminal.moreActions')}
          aria-label={t('ui.terminal.moreActions')}
        >
          <MoreHorizontal size={14} />
        </button>
      </span>
    </div>
  )
}

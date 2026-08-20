import { useDraggable, useDroppable } from '@dnd-kit/core'
import { Columns2, Plus, X } from 'lucide-react'

import { useSidebarChatTitle } from '../../hooks/useSidebarChatTitle'
import { useT } from '../../lib/i18n'
import { completeAgentHandoff } from '../../lib/tauri'
import type { Project, SubTab, Terminal, Theme, WorkspaceContainer } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentIcon } from '../icons/AgentIcons'
import styles from './PaneTabsLane.module.css'

type PaneTab = {
  key: string
  pane: Terminal
  tab: SubTab
  tabId: string
  label: string
  agent: Terminal['tabs'][number]['type']
  unread: boolean
  isActive: boolean
}

/** A pane holding several sub-tabs contributes one entry per sub-tab. */
function flattenTabs(panes: Terminal[], container: WorkspaceContainer): PaneTab[] {
  return panes.flatMap((pane) =>
    pane.tabs.map((tab) => ({
      key: `${pane.id}:${tab.id}`,
      pane,
      tab,
      tabId: tab.id,
      label: tab.name || pane.name,
      agent: tab.type,
      unread: Boolean(tab.completionUnread),
      isActive: container.activePaneId === pane.id && pane.activeTabId === tab.id,
    })),
  )
}

/** Dragging a tab reorders the bar; the workspace resolves the drop. */
function PaneTab({
  entry,
  terminalTheme,
  onActivate,
  onClose,
}: {
  entry: PaneTab
  terminalTheme: Theme
  onActivate: () => void
  onClose: () => void
}) {
  const t = useT()
  // The sidebar names a session after the conversation it is holding; the tab
  // bar reads the same source, or every Claude session of a project reads
  // "claude" and nothing tells them apart.
  const chatTitle = useSidebarChatTitle(entry.tab)
  const label = chatTitle ?? entry.label
  const draggable = useDraggable({ id: `pane:${entry.pane.id}` })
  const droppable = useDroppable({ id: `pane:${entry.pane.id}` })
  const setRefs = (node: HTMLElement | null) => {
    draggable.setNodeRef(node)
    droppable.setNodeRef(node)
  }
  const dropTarget = droppable.isOver && !draggable.isDragging
  return (
    <div
      ref={setRefs}
      className={`${styles.itemWrap} ${entry.isActive ? styles.active : ''} ${
        draggable.isDragging ? styles.dragging : ''
      } ${dropTarget ? styles.dropTarget : ''}`}
    >
      <button
        type="button"
        className={styles.item}
        onClick={onActivate}
        title={label}
        aria-current={entry.isActive ? 'true' : undefined}
        {...draggable.attributes}
        {...draggable.listeners}
      >
        <AgentIcon type={entry.agent} size={14} theme={terminalTheme} />
        <span className={styles.name}>{label}</span>
        {entry.unread ? (
          <span className={styles.doneBadge} aria-label={t('ui.terminal.responseReady')} />
        ) : null}
      </button>
      <button
        type="button"
        className={styles.close}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
        title={t('ws.tabs.close')}
        aria-label={t('ws.tabs.close')}
      >
        <X size={12} />
      </button>
    </div>
  )
}

export type PaneTabsLaneProps = {
  project: Project
  container: WorkspaceContainer
  panes: Terminal[]
}

/**
 * Every session of a project, in one row.
 *
 * The pane and its sub-tabs are two layers in the file and one here: what the
 * user has is a list of sessions, and the one they pick fills the screen.
 */
export function PaneTabsLane({ project, container, panes }: PaneTabsLaneProps) {
  const t = useT()
  const setActivePane = useProjectsStore((s) => s.setActivePane)
  const setActiveTab = useProjectsStore((s) => s.setActiveTab)
  const setSubTabCompletionUnread = useProjectsStore((s) => s.setSubTabCompletionUnread)
  const closeSubTab = useProjectsStore((s) => s.closeSubTab)
  const closePane = useProjectsStore((s) => s.closePane)
  const setSidePane = useProjectsStore((s) => s.setSidePane)
  const openModal = useUiStore((s) => s.openModal_)
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )

  const sidePane = container.sidePaneId
    ? (panes.find((pane) => pane.id === container.sidePaneId) ?? null)
    : null
  const tabs = flattenTabs(
    panes.filter((pane) => pane.id !== container.sidePaneId),
    container,
  )
  const activePane = panes.find((pane) => pane.id === container.activePaneId)
  // Only a terminal can take the space beside a session.
  const canOpenSide =
    !sidePane && (!activePane?.kind || activePane.kind === 'terminal') && panes.length > 1

  const activate = (entry: PaneTab) => {
    setActivePane(project.id, entry.pane.id)
    if (entry.pane.activeTabId !== entry.tabId) {
      setActiveTab(project.id, entry.pane.id, entry.tabId)
    }
    if (entry.unread) setSubTabCompletionUnread(project.id, entry.pane.id, entry.tabId, false)
  }

  const close = (entry: PaneTab) => {
    if (!window.confirm(t('ws.tabs.confirmClose', { name: entry.label }))) return
    // A session started from a handoff owns a packet on disk; closing it without
    // completing the handoff leaves that packet behind.
    const handoffId = entry.pane.tabs.find((tab) => tab.id === entry.tabId)?.handoff?.id
    // The last sub-tab of a pane cannot be closed on its own — closing it is
    // closing the session.
    const drop = () => {
      if (entry.pane.tabs.length > 1) closeSubTab(project.id, entry.pane.id, entry.tabId)
      else closePane(project.id, entry.pane.id)
    }
    if (!handoffId) {
      drop()
      return
    }
    void completeAgentHandoff(handoffId)
      .catch((cause) => console.warn('[handoff] could not clean the closed packet:', cause))
      .finally(drop)
  }

  return (
    <div className={styles.lane}>
      <div className={styles.tabs}>
        {tabs.map((entry) => (
          <PaneTab
            key={entry.key}
            entry={entry}
            terminalTheme={terminalTheme}
            onActivate={() => activate(entry)}
            onClose={() => close(entry)}
          />
        ))}
        <button
          type="button"
          className={styles.add}
          onClick={() => openModal('newTerminal', { projectId: project.id })}
          title={t('ws.addPaneHere')}
          aria-label={t('ws.addPaneHere')}
        >
          <Plus size={12} />
        </button>
      </div>

      {sidePane ? (
        <div className={styles.side}>
          <Columns2 size={12} />
          <span className={styles.sideName} title={sidePane.name}>
            {sidePane.name}
          </span>
          <button
            type="button"
            className={styles.close}
            onClick={() => setSidePane(project.id, null)}
            title={t('ws.tabs.closeSideTerminal')}
            aria-label={t('ws.tabs.closeSideTerminal')}
          >
            <X size={12} />
          </button>
        </div>
      ) : canOpenSide ? (
        <button
          type="button"
          className={styles.sideAction}
          onClick={() => {
            const candidate = panes.find(
              (pane) =>
                pane.id !== container.activePaneId && (!pane.kind || pane.kind === 'terminal'),
            )
            if (candidate) setSidePane(project.id, candidate.id)
          }}
          title={t('ws.tabs.openSideTerminal')}
          aria-label={t('ws.tabs.openSideTerminal')}
        >
          <Columns2 size={12} />
        </button>
      ) : null}
    </div>
  )
}

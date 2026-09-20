import { FolderGit2, GitBranch, MoreHorizontal, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import { type PaneGroup, type Terminal } from '../../lib/types'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { DotmCircular2 } from '../ui/dotm-circular-2'
import styles from './NormalProjectSidebar.module.css'

export type NormalGroupNodeProps = {
  group: PaneGroup
  panes: Terminal[]
  /** True when any session of this front is on screen. */
  open: boolean
  onOpen: () => void
  onRename: (name: string) => void
  onAddPane: () => void
  onMenu: (e: React.MouseEvent) => void
}

/**
 * One front of work in the sidebar — and only the front.
 *
 * The sessions inside it are not listed here. They are all on screen together
 * when the front is open, each carrying its own name in its header, so a second
 * copy of that list in the sidebar is the clutter the front was meant to
 * replace. The sidebar answers "what am I working on", the screen answers
 * "what is running in it".
 */
export function NormalGroupNode({
  group,
  panes,
  open,
  onOpen,
  onRename,
  onAddPane,
  onMenu,
}: NormalGroupNodeProps) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(group.name)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const runningCount = useTerminalsStore((state) =>
    panes.reduce(
      (n, pane) =>
        n +
        (pane.tabs.some((tab) => tab.ptyId && state.byPtyId[tab.ptyId]?.status === 'working')
          ? 1
          : 0),
      0,
    ),
  )

  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== group.name) onRename(next)
    else setDraft(group.name)
  }

  return (
    <div className={styles.groupNode}>
      <div
        className={`${styles.groupRow} ${open ? styles.groupRowOpen : ''}`}
        onClick={() => onOpen()}
        onDoubleClick={(event) => {
          event.stopPropagation()
          setDraft(group.name)
          setEditing(true)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onMenu(event)
        }}
        title={group.cwd || group.name}
      >
        <span className={styles.groupLead}>
          {/* The icon says where the work happens, which is the one thing about
              a front that cannot be renamed away. */}
          {group.worktreeAgentId ? <GitBranch size={13} /> : <FolderGit2 size={13} />}
        </span>
        {editing ? (
          <input
            ref={inputRef}
            className={styles.groupNameInput}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
              if (event.key === 'Escape') {
                setDraft(group.name)
                setEditing(false)
              }
            }}
          />
        ) : (
          <span className={styles.groupName}>{group.name}</span>
        )}
        {panes.length > 0 ? <span className={styles.groupCount}>{panes.length}</span> : null}
        <button
          type="button"
          className={`${styles.rowHoverBtn} ${panes.length === 0 ? styles.rowHoverBtnVisible : ''}`}
          onClick={(event) => {
            event.stopPropagation()
            onAddPane()
          }}
          title={t('ui.group.addPane')}
          aria-label={t('ui.group.addPane')}
        >
          <Plus size={14} />
        </button>
        <span className={`${styles.rowEndSlot} ${runningCount > 0 ? styles.rowEndSlotActive : ''}`}>
          {runningCount > 0 ? (
            <DotmCircular2
              size={14}
              dotSize={2}
              cellPadding={1}
              speed={1.2}
              bloom
              ariaLabel={t('ui.terminal.working')}
              className={`${styles.rosterLoading} ${styles.rowStatusIndicator}`}
            />
          ) : null}
          <button
            type="button"
            className={`${styles.rowHoverBtn} ${styles.rowEndAction}`}
            onClick={(event) => {
              event.stopPropagation()
              onMenu(event)
            }}
            title={t('ui.sidebar.moreActions')}
            aria-label={t('ui.sidebar.moreActions')}
          >
            <MoreHorizontal size={13} />
          </button>
        </span>
      </div>
    </div>
  )
}

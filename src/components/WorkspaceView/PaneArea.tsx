import { lazy, Suspense } from 'react'
import { Panel, Separator } from 'react-resizable-panels'

import type { Terminal } from '../../lib/types'
import { DiffPane } from '../DiffPane'
import { TerminalPane } from '../TerminalPane'
import { VideoPane } from '../VideoPane'
import { WebPane } from '../WebPane'
import { PersistentPanelGroup as Group } from './PersistentPanelGroup'
import styles from './WorkspaceView.module.css'

const GraphifyView = lazy(() =>
  import('../GraphifyView').then((m) => ({ default: m.GraphifyView })),
)
const MarkdownPane = lazy(() =>
  import('../MarkdownPane').then((m) => ({ default: m.MarkdownPane })),
)

function Pane({ projectId, terminal }: { projectId: string; terminal: Terminal }) {
  if (terminal.kind === 'graphify') {
    return (
      <Suspense fallback={<div className={styles.paneLoading}>Loading graph...</div>}>
        <GraphifyView repo={terminal.cwd} projectId={projectId} terminalId={terminal.id} />
      </Suspense>
    )
  }
  if (terminal.kind === 'markdown' || terminal.kind === 'file') {
    return (
      <Suspense fallback={<div className={styles.paneLoading}>Loading markdown...</div>}>
        <MarkdownPane projectId={projectId} terminal={terminal} />
      </Suspense>
    )
  }
  if (terminal.kind === 'web') return <WebPane projectId={projectId} terminal={terminal} />
  if (terminal.kind === 'video') return <VideoPane projectId={projectId} terminal={terminal} />
  if (terminal.kind === 'diff') return <DiffPane projectId={projectId} terminal={terminal} />
  return <TerminalPane projectId={projectId} terminal={terminal} />
}

/**
 * Every session of the project, stacked, with the active one on top.
 *
 * They are all mounted and all the same size. Unmounting the ones behind would
 * mean rebuilding their terminal on every tab switch, which replays the recorded
 * scrollback — the expensive path, and the one that garbles a pane when the
 * geometry it was recorded under no longer matches. Keeping the box identical
 * also means switching tabs resizes nothing.
 */
function PaneStack({
  projectId,
  panes,
  activeId,
}: {
  projectId: string
  panes: Terminal[]
  activeId: string
}) {
  return (
    <div className={styles.paneStack}>
      {panes.map((terminal) => (
        <div
          key={terminal.id}
          className={terminal.id === activeId ? styles.paneLayer : styles.paneLayerHidden}
          aria-hidden={terminal.id === activeId ? undefined : true}
        >
          <Pane projectId={projectId} terminal={terminal} />
        </div>
      ))}
    </div>
  )
}

export type PaneAreaProps = {
  projectId: string
  idPrefix: string
  /** Every session of the project, in tab order. */
  panes: Terminal[]
  /** The session filling the screen. */
  activeId: string
  /** The optional terminal next to it. */
  side?: Terminal | null
}

/**
 * What a project shows: one session, and at most one terminal beside it.
 *
 * Every other session of the project is a tab, not a pane. Two terminals on
 * screen is the ceiling — a workspace of narrow panes is what used to leave each
 * one at a width nothing else agreed on.
 */
export function PaneArea({ projectId, idPrefix, panes, activeId, side }: PaneAreaProps) {
  const stacked = panes.filter((terminal) => terminal.id !== side?.id)
  if (!side) {
    return (
      <div className={styles.singlePane}>
        <PaneStack projectId={projectId} panes={stacked} activeId={activeId} />
      </div>
    )
  }
  const activePanelId = `${idPrefix}-p-main`
  const sidePanelId = `${idPrefix}-p-${side.id}`
  return (
    <Group
      orientation="horizontal"
      className={styles.fullSize}
      persistenceId={`pane-${idPrefix}-side`}
      panelIds={[activePanelId, sidePanelId]}
    >
      <Panel id={activePanelId} defaultSize="65%" minSize="25%">
        <PaneStack projectId={projectId} panes={stacked} activeId={activeId} />
      </Panel>
      <Separator className={styles.sepH} />
      <Panel id={sidePanelId} defaultSize="35%" minSize="15%">
        <Pane projectId={projectId} terminal={side} />
      </Panel>
    </Group>
  )
}

import { lazy, Suspense } from 'react'
import { Panel, Separator } from 'react-resizable-panels'

import { paneGridCells } from '../../lib/paneLayout'
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
 * Every session of the project, in one box, with the visible ones side by side.
 *
 * They are all mounted, always, and they never change parent. Unmounting the
 * ones behind — or moving them into a different container when they come to the
 * front — would rebuild their terminal, which replays the recorded scrollback:
 * the expensive path, and the one that garbles a pane when the geometry it was
 * recorded under no longer matches.
 *
 * So the layout is done by position rather than by structure. A hidden pane
 * keeps the full box and only loses its visibility, because a terminal that
 * resizes to zero comes back wrong; a visible one is placed in its column.
 */
function PaneStack({
  projectId,
  panes,
  visibleIds,
}: {
  projectId: string
  panes: Terminal[]
  visibleIds: string[]
}) {
  // The pane shortcuts move through these same cells, so the layout lives in one place.
  const cells = paneGridCells(visibleIds.length)

  return (
    <div className={styles.paneStack}>
      {panes.map((terminal) => {
        const index = visibleIds.indexOf(terminal.id)
        const visible = index >= 0
        let placement: React.CSSProperties | undefined
        if (visible && cells.length > 1) {
          const cell = cells[index]
          placement = {
            left: `${cell.left}%`,
            width: `${cell.width}%`,
            top: `${cell.top}%`,
            height: `${cell.height}%`,
            right: 'auto',
            bottom: 'auto',
          }
        }
        return (
          <div
            key={terminal.id}
            className={visible ? styles.paneLayer : styles.paneLayerHidden}
            aria-hidden={visible ? undefined : true}
            style={placement}
          >
            <Pane projectId={projectId} terminal={terminal} />
          </div>
        )
      })}
    </div>
  )
}

export type PaneAreaProps = {
  projectId: string
  idPrefix: string
  /** Every session of the project, in tab order. */
  panes: Terminal[]
  /** The sessions on screen, left to right. Everything else stays mounted, hidden. */
  visibleIds: string[]
  /** The optional terminal next to them. */
  side?: Terminal | null
}

/**
 * What a project shows: the sessions of the front of work you are in, side by
 * side, and at most one terminal beside them.
 *
 * Sessions of the other fronts are not on screen and not tabs either — they are
 * reached through their own front. A front is meant to hold the two or three
 * panes that are worth reading together, which is why they fit next to each
 * other at all.
 */
export function PaneArea({ projectId, idPrefix, panes, visibleIds, side }: PaneAreaProps) {
  const stacked = panes.filter((terminal) => terminal.id !== side?.id)
  const visible = visibleIds.filter((id) => id !== side?.id)
  if (!side) {
    return (
      <div className={styles.singlePane}>
        <PaneStack projectId={projectId} panes={stacked} visibleIds={visible} />
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
        <PaneStack projectId={projectId} panes={stacked} visibleIds={visible} />
      </Panel>
      <Separator className={styles.sepH} />
      <Panel id={sidePanelId} defaultSize="35%" minSize="15%">
        <Pane projectId={projectId} terminal={side} />
      </Panel>
    </Group>
  )
}

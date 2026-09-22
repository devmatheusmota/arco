/**
 * The fronts of work in the order the sidebar lists them, which is the order
 * Ctrl+1…Ctrl+9 reach them in.
 */

import { formatShortcut } from './platform'
import type { PaneGroup, Project, Terminal } from './types'

export type FrontEntry = {
  projectId: string
  projectMode: Project['mode']
  group: PaneGroup
  /** Its sessions, in the project's order. Never empty: a front with none cannot be opened. */
  panes: Terminal[]
}

/**
 * Every front that can be opened: projects in sidebar order, archived ones
 * left out, fronts in the order their project keeps them. A collapsed project
 * still counts, so folding one away in the sidebar never renumbers the rest.
 */
export function orderedFronts(projectOrder: string[], projects: Project[]): FrontEntry[] {
  const byId = new Map(projects.map((project) => [project.id, project]))
  const fronts: FrontEntry[] = []
  for (const projectId of projectOrder) {
    const project = byId.get(projectId)
    if (!project || project.archived) continue
    for (const group of project.groups ?? []) {
      const panes = project.terminals.filter(
        (terminal) => terminal.groupId === group.id && !terminal.gsdSyncViewer,
      )
      if (panes.length === 0) continue
      fronts.push({ projectId: project.id, projectMode: project.mode, group, panes })
    }
  }
  return fronts
}

/** The front a Ctrl+digit opens: 1–9 by position, 0 the last, as in a browser. */
export function frontForSlot(fronts: FrontEntry[], slot: number): FrontEntry | null {
  if (slot === 0) return fronts[fronts.length - 1] ?? null
  return fronts[slot - 1] ?? null
}

/**
 * The session a front opens on: the one used last, so switching away and back
 * lands where you were; else its orchestrator; else the first.
 */
export function frontEntryPane(front: FrontEntry): Terminal {
  let entry: Terminal | null = null
  for (const pane of front.panes) {
    if ((pane.lastUsedAt ?? 0) > (entry?.lastUsedAt ?? 0)) entry = pane
  }
  return entry ?? front.panes.find((pane) => pane.pinned) ?? front.panes[0]
}

/** The chord that opens each front, by group id; fronts past the ninth get one only if last. */
export function frontShortcuts(fronts: FrontEntry[], mac?: boolean): Map<string, string> {
  const shortcuts = new Map<string, string>()
  fronts.forEach((front, index) => {
    const slot = index < 9 ? index + 1 : index === fronts.length - 1 ? 0 : null
    if (slot !== null) shortcuts.set(front.group.id, formatShortcut(`Ctrl+${slot}`, mac))
  })
  return shortcuts
}

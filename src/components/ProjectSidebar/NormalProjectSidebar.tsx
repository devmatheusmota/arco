import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  Folder,
  FolderPlus,
  GitBranch,
  Grid3x3,
  Home,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Users,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useT } from '../../lib/i18n'
import { formatShortcut } from '../../lib/platform'
import {
  sidebarDragKind,
  type SidebarDropIndicator,
  sidebarInsertionIndex,
} from '../../lib/sidebarDrag'
import { type Project } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { EmptyState } from '../EmptyState'
import { SidebarNowPlaying } from '../SidebarNowPlaying'
import { UserProfile } from '../UserProfile'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { FileExplorer } from './FileExplorer'
import { GitControl } from './GitControl'
import { NormalProjectNode as ProjectNode } from './NormalProjectNode'
import styles from './NormalProjectSidebar.module.css'
import { createSidebarMenus } from './sidebarMenus'
import { SidebarUpdate } from './SidebarUpdate'

type ContextMenuState = { x: number; y: number; items: MenuItem[] } | null

const sidebarCollisionDetection: CollisionDetection = (args) => {
  const kind = sidebarDragKind(String(args.active.id))
  const candidates = pointerWithin(args).filter(({ id }) => {
    const target = String(id)
    if (target === String(args.active.id)) return false
    if (kind === 'terminal') return target.startsWith('proj:')
    if (kind === 'project') return target.startsWith('proj:')
    return false
  })

  const rank = (id: string) => {
    if (kind === 'project') return id.startsWith('proj:') ? 0 : 1
    return 0
  }

  return candidates.sort((a, b) => {
    const rankDifference = rank(String(a.id)) - rank(String(b.id))
    if (rankDifference !== 0) return rankDifference
    const aRect = args.droppableRects.get(a.id)
    const bRect = args.droppableRects.get(b.id)
    const aArea = aRect ? aRect.width * aRect.height : Number.POSITIVE_INFINITY
    const bArea = bRect ? bRect.width * bRect.height : Number.POSITIVE_INFINITY
    return aArea - bArea
  })
}

function dropIndicatorForEvent(event: DragMoveEvent | DragEndEvent): SidebarDropIndicator | null {
  if (!event.over) return null
  const id = String(event.over.id)
  if (sidebarDragKind(String(event.active.id)) === 'terminal') {
    return { id, edge: 'inside' }
  }

  const activatorEvent = event.activatorEvent
  const pointerY =
    'clientY' in activatorEvent && typeof activatorEvent.clientY === 'number'
      ? activatorEvent.clientY + event.delta.y
      : event.active.rect.current.translated
        ? event.active.rect.current.translated.top + event.active.rect.current.translated.height / 2
        : event.over.rect.top + event.over.rect.height / 2
  const edge = pointerY < event.over.rect.top + event.over.rect.height / 2 ? 'before' : 'after'
  return { id, edge }
}

export function NormalProjectSidebar() {
  const t = useT()
  // --- data selectors (reactive) ---
  const projects = useProjectsStore((s) => s.projects)
  const projectOrder = useProjectsStore((s) => s.projectOrder)
  const containers = useProjectsStore((s) => s.workspace.containers)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const showGitControl = useProjectsStore((s) => s.preferences.enabledFeatures.git)
  const preferences = useProjectsStore((s) => s.preferences)

  // --- action selectors (stable refs, grouped for readability) ---
  const actions = useProjectsStore(
    useShallow((s) => ({
      setActiveProject: s.setActiveProject,
      openProjectWorkspace: s.openProjectWorkspace,
      openTerminalWorkspace: s.openTerminalWorkspace,
      focusWorkspaceTerminal: s.focusWorkspaceTerminal,
      toggleProjectCollapsed: s.toggleProjectCollapsed,
      renameProject: s.renameProject,
      archiveProject: s.archiveProject,
      deleteProject: s.deleteProject,
      setProjectDisabled: s.setProjectDisabled,
      renameTerminal: s.renameTerminal,
      killTerminal: s.killTerminal,
      deleteTerminal: s.deleteTerminal,
      deleteTerminalWithWorktreeCleanup: s.deleteTerminalWithWorktreeCleanup,
      setTerminalDisabled: s.setTerminalDisabled,
      moveTerminal: s.moveTerminal,
      reorderProject: s.reorderProject,
      togglePane: s.togglePane,
      openPane: s.openPane,
      setTerminalRemoteExcluded: s.setTerminalRemoteExcluded,
      setSubTabCompletionUnread: s.setSubTabCompletionUnread,
      createFilePane: s.createFilePane,
      createGraphifyPane: s.createGraphifyPane,
    })),
  )

  const requestPaneFocus = useUiStore((s) => s.requestPaneFocus)
  const openModal = useUiStore((s) => s.openModal_)
  const activeView = useUiStore((s) => s.activeView)
  const setActiveView = useUiStore((s) => s.setActiveView)
  const activeTerminalRef = useUiStore((s) => s.activeTerminal)
  const setActiveTerminal = useUiStore((s) => s.setActiveTerminal)
  const setFocusedTerminal = useUiStore((s) => s.setFocusedTerminal)
  const openMarkdownSidebar = useUiStore((s) => s.openMarkdownSidebar)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const [menu, setMenu] = useState<ContextMenuState>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropIndicator, setDropIndicator] = useState<SidebarDropIndicator | null>(null)
  const [sidebarTab, setSidebarTab] = useState<'files' | 'git' | 'projects'>('projects')
  const keepHome = activeView === 'home'

  useEffect(() => {
    if (!showGitControl && sidebarTab === 'git') setSidebarTab('projects')
  }, [showGitControl, sidebarTab])

  const openPaneSets = useMemo(() => {
    const map: Record<string, Set<string>> = {}
    for (const c of containers) map[c.projectId] = new Set(c.paneIds)
    return map
  }, [containers])

  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const activeProject = useMemo(
    () => projectsById.get(activeProjectId ?? '') ?? projects[0] ?? null,
    [activeProjectId, projects, projectsById],
  )
  const selectedTerminal = useMemo(() => {
    if (!activeProject) return null
    if (activeTerminalRef?.projectId === activeProject.id) {
      const selected = activeProject.terminals.find(
        (terminal) => terminal.id === activeTerminalRef.terminalId,
      )
      if (selected) return selected
    }
    const activeContainer = containers.find((container) => container.projectId === activeProject.id)
    const visible = new Set(activeContainer?.paneIds ?? [])
    return (
      [...activeProject.terminals]
        .filter((terminal) => visible.size === 0 || visible.has(terminal.id))
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0] ?? null
    )
  }, [activeProject, activeTerminalRef, containers])
  // Terminal real (com cwd/tabs) para o explorer e git — ignora viewers (file/diff/web)
  const sidebarTerminal = useMemo(() => {
    if (selectedTerminal && !selectedTerminal.kind) return selectedTerminal
    if (!activeProject) return null
    return (
      [...activeProject.terminals]
        .filter((t) => !t.kind)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0] ?? null
    )
  }, [selectedTerminal, activeProject])
  const sidebarSubTab =
    sidebarTerminal?.tabs.find((tab) => tab.id === sidebarTerminal.activeTabId) ??
    sidebarTerminal?.tabs[0]

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const clearDragState = () => {
    setDraggingId(null)
    setDropIndicator(null)
  }

  const updateDropIndicator = (event: DragMoveEvent) => {
    const next = dropIndicatorForEvent(event)
    setDropIndicator((current) =>
      current?.id === next?.id && current?.edge === next?.edge ? current : next,
    )
  }

  const onDragEnd = (event: DragEndEvent) => {
    const indicator = dropIndicatorForEvent(event)
    clearDragState()
    const { active, over } = event
    if (!over || !indicator) return
    const dragged = String(active.id)
    const target = String(over.id)
    if (dragged === target) return

    if (dragged.startsWith('term:') && target.startsWith('proj:')) {
      const [, fromProject, terminalId] = dragged.split(':')
      const [, toProject] = target.split(':')
      if (fromProject !== toProject) actions.moveTerminal(fromProject, terminalId, toProject)
      return
    }

    if (dragged.startsWith('proj:') && target.startsWith('proj:')) {
      const fromId = dragged.slice('proj:'.length)
      const toId = target.slice('proj:'.length)
      if (!projectsById.has(fromId) || !projectsById.has(toId)) return
      const edge = indicator.edge === 'inside' ? 'before' : indicator.edge
      const order = useProjectsStore.getState().projectOrder
      const fi = order.indexOf(fromId)
      const ti = order.indexOf(toId)
      if (fi !== -1 && ti !== -1) {
        actions.reorderProject(fromId, fi, sidebarInsertionIndex(fi, ti, edge, true))
      }
      return
    }
  }

  const draggingLabel = draggingId
    ? draggingId.startsWith('proj:')
      ? projectsById.get(draggingId.slice('proj:'.length))?.name
      : draggingId.startsWith('term:')
        ? 'Terminal'
        : null
    : null

  const { projectMenu, terminalMenu } = createSidebarMenus({
    t,
    graphifyEnabled: preferences.enabledFeatures.graphify,
    browserEnabled: preferences.enabledFeatures.browser,
    openPaneSets,
    actions: { ...actions, setPreferences },
    openModal,
    setActiveView,
    setActiveTerminal,
    setFocusedTerminal,
    requestPaneFocus,
    openMarkdownSidebar,
  })

  const activateProject = (project: Project, mode: 'open' | 'focus' = 'focus') => {
    void mode
    actions.openProjectWorkspace(project.id)
    setActiveView(project.mode === 'agentSandbox' ? 'agentSandbox' : 'workspace')
  }

  const renderProject = (p: Project) => (
    <ProjectNode
      key={p.id}
      project={p}
      isActive={p.id === activeProjectId}
      openPanes={openPaneSets[p.id]}
      onActivate={() => {
        activateProject(p)
      }}
      onToggleCollapsed={() => actions.toggleProjectCollapsed(p.id)}
      onTerminalClick={(t) => {
        if (t.gsdSyncViewer) {
          actions.openPane(p.id, t.id)
          setActiveView('workspace')
          return
        }
        actions.focusWorkspaceTerminal(p.id, t.id)
        setActiveTerminal(p.id, t.id)
        const activeTab = t.tabs.find((tab) => tab.id === t.activeTabId) ?? t.tabs[0]
        if (activeTab?.completionUnread) {
          actions.setSubTabCompletionUnread(p.id, t.id, activeTab.id, false)
        }
        requestPaneFocus(t.id)
        setActiveView(p.mode === 'agentSandbox' ? 'agentSandbox' : 'workspace')
      }}
      onTerminalDoubleClick={(t) => {
        if (t.gsdSyncViewer) {
          actions.openPane(p.id, t.id)
          setActiveView('workspace')
          return
        }
        actions.openTerminalWorkspace(p.id, t.id)
        setActiveTerminal(p.id, t.id)
        requestPaneFocus(t.id)
        setActiveView(p.mode === 'agentSandbox' ? 'agentSandbox' : 'workspace')
      }}
      onProjectMenu={(e) => setMenu({ x: e.clientX, y: e.clientY, items: projectMenu(p) })}
      onTerminalMenu={(t, e) =>
        setMenu({ x: e.clientX, y: e.clientY, items: terminalMenu(p.id, t) })
      }
      onAddTerminal={() => openModal('newTerminal', { projectId: p.id })}
      onQuickOpen={() => activateProject(p, 'open')}
      onToggleDisabled={() => {
        const visible = p.terminals.filter((term) => !term.gsdSyncViewer)
        const allDisabled = visible.length > 0 && visible.every((term) => term.disabled)
        actions.setProjectDisabled(p.id, !allDisabled)
      }}
      dropEdge={dropIndicator?.id === `proj:${p.id}` ? dropIndicator.edge : null}
    />
  )

  const visibleProjects = projectOrder
    .map((id) => projectsById.get(id))
    .filter((project): project is Project => project !== undefined && !project.archived)

  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarTabs} role="tablist" aria-label={t('ui.sidebar.navigation')}>
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'home'}
          className={`${styles.sidebarTab} ${activeView === 'home' ? styles.sidebarTabActive : ''}`}
          onClick={() => {
            if (activeView !== 'home') {
              setActiveView('home')
            }
          }}
          title={t('ui.sidebar.homeTitle', { shortcut: formatShortcut('Ctrl+Shift+H') })}
          aria-label={t('ui.sidebar.home')}
        >
          <Home size={14} />
          <span>{t('ui.sidebar.home')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sidebarTab === 'projects'}
          aria-label={t('ui.sidebar.projects')}
          title={t('ui.sidebar.projects')}
          className={`${styles.sidebarTab} ${sidebarTab === 'projects' ? styles.sidebarTabActive : ''}`}
          onClick={() => {
            setSidebarTab('projects')
            if (!keepHome) setActiveView('workspace')
          }}
        >
          <Grid3x3 size={14} />
          <span>{t('ui.sidebar.projects')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sidebarTab === 'files'}
          aria-label={t('ui.sidebar.files')}
          title={t('ui.sidebar.files')}
          className={`${styles.sidebarTab} ${sidebarTab === 'files' ? styles.sidebarTabActive : ''}`}
          onClick={() => {
            setSidebarTab('files')
            if (!keepHome) setActiveView('workspace')
          }}
        >
          <Folder size={14} />
          <span>{t('ui.sidebar.files')}</span>
        </button>
        {showGitControl && preferences.gitControlPlacement === 'left' ? (
          <button
            type="button"
            role="tab"
            aria-selected={sidebarTab === 'git'}
            aria-label={t('ui.sidebar.git')}
            title={t('ui.sidebar.git')}
            className={`${styles.sidebarTab} ${sidebarTab === 'git' ? styles.sidebarTabActive : ''}`}
            onClick={() => {
              setSidebarTab('git')
              if (!keepHome) setActiveView('workspace')
            }}
          >
            <GitBranch size={14} />
            <span>{t('ui.sidebar.git')}</span>
          </button>
        ) : null}
      </div>

      <div className={styles.quickNavList}>
        <button
          type="button"
          className={styles.quickNavItem}
          onClick={() => openModal('findJump')}
          title={t('ui.sidebar.search')}
        >
          <Search size={16} className={styles.quickNavIcon} />
          <span>{t('ui.sidebar.search')}</span>
        </button>
      </div>

      {sidebarTab === 'projects' ? (
        <header className={styles.header}>
          <span className={styles.title}>{t('ui.sidebar.projects')}</span>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => openModal('newProject')}
              title={t('ui.sidebar.newProjectTitle', { shortcut: formatShortcut('Ctrl+Shift+P') })}
              aria-label={t('ui.sidebar.newProject')}
            >
              <Plus size={14} />
            </button>
          </div>
        </header>
      ) : null}

      {sidebarTab === 'files' ? (
        <section className={styles.explorerPanel}>
          <div className={styles.explorerHeader}>
            <span className={styles.explorerLabel}>{t('ui.sidebar.explorer')}</span>
            <MoreHorizontal size={14} />
          </div>
          {sidebarTerminal && sidebarSubTab && activeProject ? (
            <FileExplorer
              projectId={activeProject.id}
              cwd={sidebarSubTab.cwd || sidebarTerminal.cwd}
              ptyId={sidebarSubTab.ptyId}
              terminalName={sidebarTerminal.name}
            />
          ) : (
            <div className={styles.explorerEmpty}>
              <EmptyState
                compact
                icon={<FolderPlus size={18} />}
                title={t('ui.sidebar.emptyTitle')}
                description={t('ui.sidebar.emptyDesc')}
                primaryAction={{
                  label: t('ui.sidebar.emptyAction'),
                  onClick: () => openModal('newProject'),
                }}
              />
            </div>
          )}
        </section>
      ) : null}

      {sidebarTab === 'git' ? (
        <section className={styles.explorerPanel}>
          <div className={styles.explorerHeader}>
            <span className={styles.explorerLabel}>{t('ui.sidebar.sourceControl')}</span>
          </div>
          {sidebarTerminal && sidebarSubTab && activeProject ? (
            <GitControl
              projectId={activeProject.id}
              cwd={sidebarSubTab.cwd || sidebarTerminal.cwd}
              ptyId={sidebarSubTab.ptyId}
              terminalName={sidebarTerminal.name}
            />
          ) : (
            <div className={styles.explorerEmpty}>
              <EmptyState
                compact
                icon={<GitBranch size={18} />}
                title={t('git.empty.noTerminal')}
                description={t('git.empty.noTerminalDesc')}
                primaryAction={{
                  label: t('ui.sidebar.emptyAction'),
                  onClick: () => openModal('newProject'),
                }}
              />
            </div>
          )}
        </section>
      ) : null}

      {sidebarTab === 'projects' ? (
        <DndContext
          sensors={sensors}
          collisionDetection={sidebarCollisionDetection}
          onDragStart={({ active }) => {
            setDraggingId(String(active.id))
            setDropIndicator(null)
          }}
          onDragMove={updateDropIndicator}
          onDragOver={updateDropIndicator}
          onDragCancel={clearDragState}
          onDragEnd={onDragEnd}
        >
          <div className={styles.list}>
            {projects.length === 0 ? (
              <div className={styles.emptyWrap}>
                <EmptyState
                  compact
                  icon={<FolderPlus size={18} />}
                  title={t('ui.sidebar.emptyTitle')}
                  description={t('ui.sidebar.emptyDesc')}
                  primaryAction={{
                    label: t('ui.sidebar.emptyAction'),
                    onClick: () => openModal('newProject'),
                  }}
                />
              </div>
            ) : (
              <div className={styles.projectList}>
                {visibleProjects.map((project) => renderProject(project))}
              </div>
            )}
          </div>
          <DragOverlay dropAnimation={null}>
            {draggingId && draggingLabel ? (
              <div className={styles.dragOverlay}>
                <Folder size={14} />
                <span>{draggingLabel}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : null}

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      ) : null}
      {preferences.topbarStyle === 'three-areas' ? (
        <div className={styles.systemFooter}>
          <span className={styles.systemFooterLabel}>{t('ui.sidebar.system')}</span>
          <div className={styles.systemFooterActions}>
            {preferences.topbarShowSync ? (
              <button
                type="button"
                className={styles.systemFooterBtn}
                onClick={() => openModal('sync')}
                title={t('sync.title')}
                aria-label={t('sync.title')}
              >
                <RefreshCw size={14} />
              </button>
            ) : null}
            {preferences.topbarShowProfile ? (
              <button
                type="button"
                className={styles.systemFooterBtn}
                onClick={() => openModal('profiles')}
                title={t('profile.manageAccounts')}
                aria-label={t('profile.manageAccounts')}
              >
                <Users size={14} />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <SidebarNowPlaying />
      <SidebarUpdate />
      <UserProfile />
    </aside>
  )
}

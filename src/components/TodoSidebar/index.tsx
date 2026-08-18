import {
  Check,
  ChevronDown,
  FolderKanban,
  GripVertical,
  ListTodo,
  Pencil,
  Play,
  Plus,
  StickyNote,
  Tag,
  Trash2,
  Unlink,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { type GsdSyncSession, useGsdSyncSessions } from '../../hooks/useGsdSyncSessions'
import { formatRelativeTimestamp } from '../../lib/greeting'
import { type TFunction, useT } from '../../lib/i18n'
import { formatShortcut } from '../../lib/platform'
import { type PlanningStatus, readPlanningStatus } from '../../lib/tauri'
import {
  collectTodoTags,
  normalizeTodoPriority,
  sortTodosByPriority,
  TODO_TITLE_MAX_LENGTH,
} from '../../lib/todos'
import {
  AGENT_TYPE_LABELS,
  type Project,
  type Terminal,
  TODO_PRIORITIES,
  type TodoItem,
  type TodoPriority,
  type TodoSessionLink,
} from '../../lib/types'
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { DotmCircular2 } from '../ui/dotm-circular-2'
import styles from './TodoSidebar.module.css'

/** A session link paired with the pane it points at, when that pane still exists. */
type ResolvedSession = {
  link: TodoSessionLink
  project: Project | null
  terminal: Terminal | null
}

function resolveSessions(todo: TodoItem, projects: Project[]): ResolvedSession[] {
  return (todo.sessions ?? []).map((link) => {
    const project = projects.find((item) => item.id === link.projectId) ?? null
    const terminal = project?.terminals.find((item) => item.id === link.terminalId) ?? null
    return { link, project, terminal }
  })
}

function isTerminalWorking(
  terminal: Terminal,
  byPtyId: Record<string, { status: string }>,
): boolean {
  return terminal.tabs.some((tab) => tab.ptyId && byPtyId[tab.ptyId]?.status === 'working')
}

/** Brings a linked pane to the front, wherever the user currently is. */
function useSessionFocus() {
  const setActiveView = useUiStore((state) => state.setActiveView)
  const setActiveTerminal = useUiStore((state) => state.setActiveTerminal)
  const requestPaneFocus = useUiStore((state) => state.requestPaneFocus)
  return (projectId: string, terminalId: string) => {
    const store = useProjectsStore.getState()
    store.setActiveProjectOnly(projectId)
    store.focusWorkspaceTerminal(projectId, terminalId)
    setActiveTerminal(projectId, terminalId)
    requestPaneFocus(terminalId)
    setActiveView('workspace')
  }
}

function GsdSyncSection() {
  const t = useT()
  const activeProject = useProjectsStore(selectActiveProject)
  const setFullscreenPane = useProjectsStore((state) => state.setFullscreenPane)
  const sessions = useGsdSyncSessions()
  const projectSessions = activeProject
    ? sessions.filter((session) => session.projectId === activeProject.id)
    : []

  if (!activeProject || projectSessions.length === 0) return null

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span>{t('todo.gsdSectionTitle')}</span>
        <span className={styles.sectionCount}>{projectSessions.length}</span>
      </div>
      <div className={styles.list}>
        {projectSessions.map((session) => {
          const terminal = activeProject.terminals.find((term) => term.id === session.terminalId)
          if (!terminal) return null
          return (
            <GsdSyncRow
              key={session.id}
              terminal={terminal}
              session={session}
              onOpen={() => setFullscreenPane(session.terminalId)}
            />
          )
        })}
      </div>
    </section>
  )
}

function GsdSyncRow({
  terminal,
  session,
  onOpen,
}: {
  terminal: Terminal
  session: GsdSyncSession
  onOpen: () => void
}) {
  const t = useT()
  const [status, setStatus] = useState<PlanningStatus | null>(null)

  useEffect(() => {
    if (!terminal.cwd) return
    let cancelled = false
    readPlanningStatus(terminal.cwd)
      .then((result) => {
        if (!cancelled) setStatus(result)
      })
      .catch(() => {
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [terminal.cwd, session.busy])

  const statusLabel = session.hasError
    ? t('todo.gsdError')
    : session.busy
      ? t('todo.gsdBusy')
      : t('todo.gsdIdle')
  const progressLabel =
    status?.roadmapTotalCount != null && status.roadmapPendingCount != null
      ? t('todo.gsdProgress', {
          done: status.roadmapTotalCount - status.roadmapPendingCount,
          total: status.roadmapTotalCount,
        })
      : null

  return (
    <button type="button" className={styles.gsdRow} onClick={onOpen} title={terminal.name}>
      <span className={styles.gsdRowState}>
        {session.hasError ? (
          <span className={styles.gsdErrorDot} />
        ) : session.busy ? (
          <DotmCircular2
            size={13}
            dotSize={2}
            cellPadding={1}
            speed={1.2}
            bloom
            ariaLabel={statusLabel}
          />
        ) : (
          <span className={styles.gsdIdleDot} />
        )}
      </span>
      <span className={styles.gsdRowBody}>
        <span className={styles.gsdRowName}>{terminal.name}</span>
        <span className={styles.gsdRowMeta}>{progressLabel ?? statusLabel}</span>
      </span>
    </button>
  )
}

type DragState = {
  draggedId: string | null
  dropTargetId: string | null
  onDragStart: (todo: TodoItem, event: React.DragEvent) => void
  onDragEnd: () => void
  onDragOver: (todo: TodoItem, event: React.DragEvent) => void
  onDragLeave: (todo: TodoItem) => void
  onDrop: (todo: TodoItem, event: React.DragEvent) => void
}

function TodoRow({
  todo,
  projects,
  drag,
  expanded,
  onToggleExpanded,
  position,
  total,
  onMoveUp,
  onMoveDown,
}: {
  todo: TodoItem
  projects: Project[]
  drag: DragState
  expanded: boolean
  onToggleExpanded: () => void
  position: number
  total: number
  onMoveUp?: () => void
  onMoveDown?: () => void
}) {
  const t = useT()
  const renameTodo = useProjectsStore((state) => state.renameTodo)
  const updateTodoTags = useProjectsStore((state) => state.updateTodoTags)
  const updateTodoNotes = useProjectsStore((state) => state.updateTodoNotes)
  const setTodoPriority = useProjectsStore((state) => state.setTodoPriority)
  const setTodoProject = useProjectsStore((state) => state.setTodoProject)
  const unlinkTodoSession = useProjectsStore((state) => state.unlinkTodoSession)
  const toggleTodo = useProjectsStore((state) => state.toggleTodo)
  const deleteTodo = useProjectsStore((state) => state.deleteTodo)
  const openModal = useUiStore((state) => state.openModal_)
  const focusSession = useSessionFocus()

  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(todo.title)
  const [notesDraft, setNotesDraft] = useState(todo.notes ?? '')

  useEffect(() => {
    if (!expanded) setNotesDraft(todo.notes ?? '')
  }, [expanded, todo.notes])

  const sessions = useMemo(() => resolveSessions(todo, projects), [todo, projects])
  const liveSessions = sessions.filter((session) => session.terminal)
  const workingCount = useTerminalsStore(
    (state) =>
      liveSessions.filter((session) => isTerminalWorking(session.terminal!, state.byPtyId)).length,
  )
  const priority = normalizeTodoPriority(todo.priority)

  const finishEditing = () => {
    if (editTitle.trim()) renameTodo(todo.id, editTitle)
    setEditing(false)
  }

  const startEditing = () => {
    setEditTitle(todo.title)
    setEditing(true)
  }

  const editTags = () => {
    const value = window.prompt(t('todo.tagsPrompt'), todo.tags.join(', '))
    if (value === null) return
    updateTodoTags(todo.id, parseTags(value))
  }

  const commitNotes = () => {
    if ((todo.notes ?? '') === notesDraft) return
    updateTodoNotes(todo.id, notesDraft)
  }

  return (
    <div className={styles.todoItem}>
      <div
        className={[
          styles.todoRow,
          todo.completed ? styles.todoRowCompleted : '',
          expanded ? styles.todoRowExpanded : '',
          drag.draggedId === todo.id ? styles.todoRowDragging : '',
          drag.dropTargetId === todo.id && drag.draggedId !== todo.id
            ? styles.todoRowDropTarget
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        draggable={!editing}
        onDragStart={(event) => drag.onDragStart(todo, event)}
        onDragEnd={drag.onDragEnd}
        onDragOver={(event) => drag.onDragOver(todo, event)}
        onDragLeave={() => drag.onDragLeave(todo)}
        onDrop={(event) => drag.onDrop(todo, event)}
      >
        <span
          className={styles.priorityMarker}
          data-priority={priority}
          title={t('todo.priorityMarker', { priority: t(`todo.priority.${priority}`) })}
        />
        {/* Reordering was mouse-only: the handle was unreachable by keyboard and
            had no commands. Arrow keys move the item, and the label carries the
            position so the change is announced. */}
        <button
          type="button"
          className={styles.dragHandle}
          title={t('todo.drag')}
          aria-label={t('todo.dragPosition', { position, total })}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' && onMoveUp) {
              event.preventDefault()
              onMoveUp()
            }
            if (event.key === 'ArrowDown' && onMoveDown) {
              event.preventDefault()
              onMoveDown()
            }
          }}
        >
          <GripVertical size={13} />
        </button>
        <button
          type="button"
          className={styles.checkButton}
          onClick={() => toggleTodo(todo.id)}
          title={todo.completed ? t('todo.reopen') : t('todo.complete')}
          aria-label={todo.completed ? t('todo.reopen') : t('todo.complete')}
        >
          {todo.completed ? <Check size={12} /> : null}
        </button>

        {editing ? (
          <input
            autoFocus
            className={styles.editInput}
            value={editTitle}
            maxLength={TODO_TITLE_MAX_LENGTH}
            onChange={(event) => setEditTitle(event.target.value)}
            // Clicking away used to close the field without saving, discarding
            // a perfectly valid edit with no warning. Escape is the way out
            // that keeps the original title.
            onBlur={finishEditing}
            onKeyDown={(event) => {
              if (event.key === 'Enter') finishEditing()
              if (event.key === 'Escape') setEditing(false)
            }}
            aria-label={t('todo.edit')}
          />
        ) : (
          <button
            type="button"
            className={styles.titleButton}
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            title={expanded ? t('todo.collapse') : t('todo.expand')}
          >
            <span className={styles.todoTitleText}>{todo.title}</span>
            <span className={styles.metaRow}>
              {todo.tags.map((tag) => (
                <span key={tag} className={styles.tag}>
                  #{tag}
                </span>
              ))}
              {todo.notes ? (
                <span className={styles.metaIcon} title={t('todo.notesIndicator')}>
                  <StickyNote size={10} />
                </span>
              ) : null}
              {liveSessions.length > 0 ? (
                <span
                  className={styles.sessionBadge}
                  data-working={workingCount > 0 ? 'true' : 'false'}
                  title={t('todo.sessionCount', { count: liveSessions.length })}
                >
                  {workingCount > 0 ? (
                    <DotmCircular2
                      size={11}
                      dotSize={2}
                      cellPadding={1}
                      speed={1.2}
                      ariaLabel={t('todo.sessionWorking')}
                    />
                  ) : (
                    <span className={styles.sessionDot} />
                  )}
                  {liveSessions.length}
                </span>
              ) : null}
            </span>
          </button>
        )}

        <div className={styles.rowActions}>
          {editing ? (
            <>
              <button
                type="button"
                className={styles.rowAction}
                onClick={editTags}
                title={t('todo.editTags')}
                aria-label={t('todo.editTags')}
              >
                <Tag size={12} />
              </button>
              <button
                type="button"
                className={styles.rowAction}
                onMouseDown={(event) => event.preventDefault()}
                onClick={finishEditing}
                title={t('todo.saveEdit')}
                aria-label={t('todo.saveEdit')}
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                className={styles.rowAction}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setEditing(false)}
                title={t('common.cancel')}
                aria-label={t('common.cancel')}
              >
                <X size={13} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`${styles.rowAction} ${styles.startAction}`}
                onClick={() => openModal('taskSession', { todoId: todo.id })}
                title={t('todo.startSession')}
                aria-label={t('todo.startSession')}
              >
                <Play size={12} />
              </button>
              <button
                type="button"
                className={styles.rowAction}
                onClick={startEditing}
                title={t('todo.edit')}
                aria-label={t('todo.edit')}
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                className={`${styles.rowAction} ${styles.deleteAction}`}
                onClick={() => deleteTodo(todo.id)}
                title={t('todo.delete')}
                aria-label={t('todo.delete')}
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
        </div>
      </div>

      {expanded ? (
        <div className={styles.details}>
          <div className={styles.detailBlock}>
            <span className={styles.detailLabel}>{t('todo.priority')}</span>
            <div className={styles.priorityRow}>
              {TODO_PRIORITIES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`${styles.priorityPill} ${priority === value ? styles.priorityPillActive : ''}`}
                  data-priority={value}
                  aria-pressed={priority === value}
                  onClick={() => setTodoPriority(todo.id, value as TodoPriority)}
                >
                  {t(`todo.priority.${value}`)}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.detailBlock}>
            <span className={styles.detailLabel}>{t('todo.notes')}</span>
            <textarea
              className={styles.notesInput}
              value={notesDraft}
              rows={3}
              placeholder={t('todo.notesPlaceholder')}
              onChange={(event) => setNotesDraft(event.target.value)}
              onBlur={commitNotes}
            />
          </div>

          <div className={styles.detailBlock}>
            <span className={styles.detailLabel}>{t('todo.linkProject')}</span>
            <ProjectPicker
              value={todo.projectId ?? ''}
              projects={projects}
              noProjectLabel={t('todo.noProject')}
              ariaLabel={t('todo.linkProject')}
              onChange={(projectId) => setTodoProject(todo.id, projectId || null)}
            />
          </div>

          {sessions.length > 0 ? (
            <div className={styles.detailBlock}>
              <span className={styles.detailLabel}>{t('todo.sessionsTitle')}</span>
              <div className={styles.sessionList}>
                {sessions.map((session) => (
                  <SessionRow
                    key={session.link.terminalId}
                    session={session}
                    t={t}
                    onOpen={() => focusSession(session.link.projectId, session.link.terminalId)}
                    onUnlink={() => unlinkTodoSession(todo.id, session.link.terminalId)}
                  />
                ))}
              </div>
            </div>
          ) : null}

          <div className={styles.detailFooter}>
            <span className={styles.detailMeta}>
              {todo.completed && todo.completedAt
                ? t('todo.metaCompleted', { date: formatRelativeTimestamp(todo.completedAt) })
                : todo.createdAt
                  ? t('todo.metaCreated', { date: formatRelativeTimestamp(todo.createdAt) })
                  : ''}
            </span>
            <button
              type="button"
              className={styles.startSessionButton}
              onClick={() => openModal('taskSession', { todoId: todo.id })}
            >
              <Play size={12} />
              {t('todo.startSession')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function SessionRow({
  session,
  t,
  onOpen,
  onUnlink,
}: {
  session: ResolvedSession
  t: TFunction
  onOpen: () => void
  onUnlink: () => void
}) {
  const terminal = session.terminal
  const working = useTerminalsStore((state) =>
    terminal ? isTerminalWorking(terminal, state.byPtyId) : false,
  )
  const label = AGENT_TYPE_LABELS[session.link.agent] ?? session.link.agent
  const stateLabel = !terminal
    ? t('todo.sessionGone')
    : working
      ? t('todo.sessionWorking')
      : t('todo.sessionIdle')

  return (
    <div className={styles.sessionRow} data-gone={terminal ? 'false' : 'true'}>
      <button
        type="button"
        className={styles.sessionRowMain}
        onClick={onOpen}
        disabled={!terminal}
        title={terminal ? t('todo.sessionOpen') : t('todo.sessionGone')}
      >
        <span className={styles.sessionAgentDot} data-agent={session.link.agent} />
        <span className={styles.sessionRowName}>{terminal?.name ?? label}</span>
        <span className={styles.sessionRowMeta}>
          {stateLabel} · {formatRelativeTimestamp(session.link.startedAt)}
        </span>
      </button>
      <button
        type="button"
        className={styles.sessionUnlink}
        onClick={onUnlink}
        title={t('todo.sessionUnlink')}
        aria-label={t('todo.sessionUnlink')}
      >
        <Unlink size={11} />
      </button>
    </div>
  )
}

export function TodoSidebar() {
  const t = useT()
  const todos = useProjectsStore((state) => state.todos)
  const projects = useProjectsStore((state) => state.projects)
  const createTodo = useProjectsStore((state) => state.createTodo)
  const reorderTodo = useProjectsStore((state) => state.reorderTodo)
  const [title, setTitle] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [projectDraft, setProjectDraft] = useState('')
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set(['completed']),
  )
  const addInputRef = useRef<HTMLInputElement>(null)

  const availableTags = useMemo(() => collectTodoTags(todos), [todos])
  useEffect(() => {
    if (tagFilter && !availableTags.includes(tagFilter)) setTagFilter(null)
  }, [availableTags, tagFilter])

  const visible = useMemo(
    () => (tagFilter ? todos.filter((todo) => todo.tags.includes(tagFilter)) : todos),
    [tagFilter, todos],
  )
  const active = visible.filter((todo) => !todo.completed)
  const completed = visible.filter((todo) => todo.completed)
  const progress = visible.length > 0 ? Math.round((completed.length / visible.length) * 100) : 0
  const activeProjectSections = projects
    .map((project) => ({
      key: `project:${project.id}`,
      label: project.name,
      projectId: project.id,
      iconUrl: project.iconUrl,
      items: sortTodosByPriority(active.filter((todo) => todo.projectId === project.id)),
    }))
    .filter((section) => section.items.length > 0)
  const unassigned = sortTodosByPriority(active.filter((todo) => !todo.projectId))

  const runningCount = useTerminalsStore(
    (state) =>
      todos.filter((todo) =>
        resolveSessions(todo, projects).some(
          (session) => session.terminal && isTerminalWorking(session.terminal, state.byPtyId),
        ),
      ).length,
  )

  useEffect(() => {
    const focusComposer = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'n') return
      event.preventDefault()
      setComposerExpanded(true)
      addInputRef.current?.focus()
    }
    window.addEventListener('keydown', focusComposer, true)
    return () => window.removeEventListener('keydown', focusComposer, true)
  }, [])

  const submit = () => {
    if (!createTodo(title, parseTags(tagDraft), projectDraft || undefined)) return
    setTitle('')
    setTagDraft('')
    setProjectDraft('')
    setComposerExpanded(false)
  }

  const toggleSection = (key: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const startProjectTodo = (projectId = '') => {
    setProjectDraft(projectId)
    setComposerExpanded(true)
    window.requestAnimationFrame(() => addInputRef.current?.focus())
  }

  const drag: DragState = {
    draggedId,
    dropTargetId,
    onDragStart: (todo, event) => {
      setDraggedId(todo.id)
      setDropTargetId(null)
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', todo.id)
    },
    onDragEnd: () => {
      setDraggedId(null)
      setDropTargetId(null)
    },
    onDragOver: (todo, event) => {
      if (!draggedId) return
      const dragged = todos.find((item) => item.id === draggedId)
      if (dragged?.completed !== todo.completed) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDropTargetId(todo.id)
    },
    onDragLeave: (todo) => {
      if (dropTargetId === todo.id) setDropTargetId(null)
    },
    onDrop: (todo, event) => {
      event.preventDefault()
      if (draggedId) reorderTodo(draggedId, todo.id)
      setDraggedId(null)
      setDropTargetId(null)
    },
  }

  const renderSection = ({
    key,
    label,
    items,
    completedSection = false,
    projectId,
    iconUrl,
  }: {
    key: string
    label: string
    items: TodoItem[]
    completedSection?: boolean
    projectId?: string
    iconUrl?: string
  }) => {
    const collapsed = collapsedSections.has(key)
    return (
      <section key={key} className={styles.section}>
        <div className={styles.sectionHeader}>
          <button
            type="button"
            className={styles.sectionToggle}
            onClick={() => toggleSection(key)}
            aria-expanded={!collapsed}
          >
            <ChevronDown
              size={13}
              className={`${styles.sectionChevron} ${collapsed ? styles.sectionChevronClosed : ''}`}
            />
            {iconUrl ? <img src={iconUrl} alt="" className={styles.sectionIcon} /> : null}
            <span className={styles.sectionName}>{label}</span>
            <span className={styles.sectionCount}>{items.length}</span>
            <span className={styles.sectionRule} />
          </button>
          {!completedSection ? (
            <button
              type="button"
              className={styles.sectionAdd}
              onClick={() => startProjectTodo(projectId)}
              title={t('todo.add')}
              aria-label={t('todo.add')}
            >
              <Plus size={13} />
            </button>
          ) : null}
        </div>
        {!collapsed && items.length > 0 ? (
          <div className={styles.list}>
            {items.map((todo, index) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                projects={projects}
                drag={drag}
                expanded={expandedIds.has(todo.id)}
                onToggleExpanded={() => toggleExpanded(todo.id)}
                position={index + 1}
                total={items.length}
                onMoveUp={index > 0 ? () => reorderTodo(todo.id, items[index - 1].id) : undefined}
                // Moving down is the neighbour moving up: the reorder inserts
                // the dragged item where the target sits, so aiming at the item
                // below would land it back in place.
                onMoveDown={
                  index < items.length - 1
                    ? () => reorderTodo(items[index + 1].id, todo.id)
                    : undefined
                }
              />
            ))}
          </div>
        ) : completedSection && visible.length > 0 ? (
          <p className={styles.sectionEmpty}>{t('todo.emptyCompleted')}</p>
        ) : null}
      </section>
    )
  }

  return (
    <aside className={styles.sidebar} aria-label={t('todo.title')}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.heading}>
            <ListTodo size={17} />
            <span>{t('todo.title')}</span>
          </div>
          {runningCount > 0 ? (
            <span className={styles.runningPill}>
              <DotmCircular2
                size={11}
                dotSize={2}
                cellPadding={1}
                speed={1.2}
                ariaLabel={t('todo.sessionWorking')}
              />
              {t('todo.runningCount', { count: runningCount })}
            </span>
          ) : null}
        </div>
        <div
          className={styles.progress}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={visible.length}
          aria-valuenow={completed.length}
        >
          <span className={styles.progressTrack}>
            <span className={styles.progressFill} style={{ width: `${progress}%` }} />
          </span>
          <span className={styles.progressCount}>
            {completed.length} / {visible.length}
          </span>
        </div>
        <div className={styles.filters} role="tablist" aria-label={t('todo.filters')}>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'all'}
            className={`${styles.filterButton} ${filter === 'all' ? styles.filterButtonActive : ''}`}
            onClick={() => setFilter('all')}
          >
            {t('todo.all')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'active'}
            className={`${styles.filterButton} ${filter === 'active' ? styles.filterButtonActive : ''}`}
            onClick={() => setFilter('active')}
          >
            {t('todo.active')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'completed'}
            className={`${styles.filterButton} ${filter === 'completed' ? styles.filterButtonActive : ''}`}
            onClick={() => setFilter('completed')}
          >
            {t('todo.completed')}
          </button>
        </div>
        {availableTags.length > 0 ? (
          <div className={styles.tagFilters} aria-label={t('todo.tagFilterLabel')}>
            <button
              type="button"
              className={`${styles.tagFilter} ${!tagFilter ? styles.tagFilterActive : ''}`}
              onClick={() => setTagFilter(null)}
            >
              {t('todo.tagFilterAll')}
            </button>
            {availableTags.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`${styles.tagFilter} ${tagFilter === tag ? styles.tagFilterActive : ''}`}
                onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
              >
                #{tag}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      <form
        className={styles.addForm}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className={styles.composerBox}>
          <button
            type="submit"
            className={styles.composerSubmit}
            disabled={!title.trim()}
            title={t('todo.add')}
            aria-label={t('todo.add')}
          >
            <Plus size={15} />
          </button>
          <input
            ref={addInputRef}
            className={styles.composerInput}
            value={title}
            maxLength={TODO_TITLE_MAX_LENGTH}
            onFocus={() => setComposerExpanded(true)}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !title.trim()) setComposerExpanded(false)
            }}
            placeholder={t('todo.addPlaceholder')}
            aria-label={t('todo.addPlaceholder')}
          />
          <kbd className={styles.composerShortcut}>{formatShortcut('Ctrl+N')}</kbd>
        </div>
        {composerExpanded ? (
          <div className={styles.composerDetails}>
            <div className={styles.tagInputWrap}>
              <Tag size={13} aria-hidden="true" />
              <input
                className={`${styles.addInput} ${styles.addTagInput}`}
                value={tagDraft}
                onChange={(event) => setTagDraft(event.target.value)}
                placeholder={t('todo.tagsPlaceholder')}
                aria-label={t('todo.tagsPlaceholder')}
              />
            </div>
            <ProjectPicker
              value={projectDraft}
              projects={projects}
              noProjectLabel={t('todo.noProject')}
              ariaLabel={t('todo.linkProject')}
              onChange={setProjectDraft}
            />
          </div>
        ) : null}
      </form>

      <div className={styles.content}>
        {filter !== 'completed' ? <GsdSyncSection /> : null}
        {visible.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>
              <ListTodo size={20} />
            </div>
            <strong>{t('todo.emptyTitle')}</strong>
            <span>{t('todo.emptyDescription')}</span>
          </div>
        ) : (
          <>
            {filter !== 'completed'
              ? activeProjectSections.map((section) => renderSection(section))
              : null}
            {filter !== 'completed' && unassigned.length > 0
              ? renderSection({
                  key: 'unassigned',
                  label: t('todo.noProject'),
                  items: unassigned,
                })
              : null}
            {filter !== 'active'
              ? renderSection({
                  key: 'completed',
                  label: t('todo.completed'),
                  items: completed,
                  completedSection: true,
                })
              : null}
            {filter === 'active' && active.length === 0 ? (
              <p className={styles.filterEmpty}>{t('todo.emptyTitle')}</p>
            ) : null}
          </>
        )}
      </div>
    </aside>
  )
}

function ProjectPicker({
  value,
  projects,
  noProjectLabel,
  ariaLabel,
  onChange,
}: {
  value: string
  projects: Array<{ id: string; name: string }>
  noProjectLabel: string
  ariaLabel: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0, width: 240 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selectedLabel = projects.find((project) => project.id === value)?.name ?? noProjectLabel

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('click', closeOnOutsideClick)
    return () => document.removeEventListener('click', closeOnOutsideClick)
  }, [open])

  useEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(300, Math.max(220, rect.width), window.innerWidth - 16)
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      const estimatedHeight = Math.min(240, (projects.length + 1) * 32 + 8)
      const roomBelow = window.innerHeight - rect.bottom - 8
      const top =
        roomBelow >= Math.min(estimatedHeight, 180)
          ? rect.bottom + 5
          : Math.max(8, rect.top - estimatedHeight - 5)
      setMenuPosition({ left, top, width })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, projects.length])

  const choose = (nextValue: string) => {
    onChange(nextValue)
    setOpen(false)
  }

  return (
    <div className={styles.projectInputWrap}>
      <FolderKanban size={13} aria-hidden="true" />
      <button
        ref={triggerRef}
        type="button"
        className={styles.projectPickerButton}
        aria-label={ariaLabel}
        aria-expanded={open}
        title={selectedLabel}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((current) => !current)
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span>{selectedLabel}</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className={styles.projectMenu}
              role="listbox"
              aria-label={ariaLabel}
              style={menuPosition}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                role="option"
                aria-selected={!value}
                className={`${styles.projectOption} ${!value ? styles.projectOptionSelected : ''}`}
                onClick={(event) => {
                  event.stopPropagation()
                  choose('')
                }}
              >
                {noProjectLabel}
              </button>
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  role="option"
                  aria-selected={project.id === value}
                  className={`${styles.projectOption} ${project.id === value ? styles.projectOptionSelected : ''}`}
                  title={project.name}
                  onClick={(event) => {
                    event.stopPropagation()
                    choose(project.id)
                  }}
                >
                  {project.name}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

function parseTags(value: string): string[] {
  return value
    .split(/[,#\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

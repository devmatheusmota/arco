import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { useMemo, useState } from 'react'

import { useSessionFocus } from '../../hooks/useSessionFocus'
import { liveSessionOf, resolveBoardDrop } from '../../lib/boardDrop'
import { useT } from '../../lib/i18n'
import { normalizeTodoPriority, normalizeTodoStatus } from '../../lib/todos'
import { TODO_STATUSES, type TodoItem, type TodoStatus } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { DotmCircular2 } from '../ui/dotm-circular-2'
import styles from './BoardView.module.css'

// The task board.
//
// It owns no state of its own. Columns are `TODO_STATUSES`, moving a card calls
// `setTodoStatus` — the same action the list's status pills call — so the board
// and the sidebar cannot drift: they are two views of one field.

const CARD = 'card:'
const COLUMN = 'col:'

function Card({
  todo,
  projectName,
  session,
  working,
  onOpen,
}: {
  todo: TodoItem
  projectName: string | null
  session: { projectId: string; terminalId: string } | null
  working: boolean
  onOpen: (() => void) | undefined
}) {
  const t = useT()
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${CARD}${todo.id}`,
  })
  const priority = normalizeTodoPriority(todo.priority)

  return (
    <article
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`${styles.card} ${isDragging ? styles.cardDragging : ''}`}
      data-priority={priority}
      data-session={session ? 'true' : undefined}
      // A single click is the start of a drag, so opening the session takes two
      // — the same bargain a file manager makes. The keyboard gets Enter, since
      // a double click is not something a keyboard can express.
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (!onOpen || event.key !== 'Enter') return
        event.preventDefault()
        onOpen()
      }}
      tabIndex={onOpen ? 0 : undefined}
      title={onOpen ? t('board.openSession') : undefined}
    >
      <span className={styles.cardPriority} data-priority={priority} aria-hidden="true" />
      <div className={styles.cardHead}>
        <p className={styles.cardTitle}>{todo.title}</p>
        {/* Which tasks are already being worked on is the question the board is
            asked most, and the status column cannot answer it: a task sits in
            "in progress" whether or not anything is running for it. */}
        {session ? (
          <span
            className={styles.cardSession}
            data-working={working ? 'true' : 'false'}
            title={working ? t('board.sessionWorking') : t('board.sessionIdle')}
            aria-label={working ? t('board.sessionWorking') : t('board.sessionIdle')}
          >
            {working ? (
              <DotmCircular2 size={12} dotSize={2} cellPadding={1} speed={1.2} />
            ) : (
              <span className={styles.cardSessionDot} />
            )}
          </span>
        ) : null}
      </div>
      {projectName || todo.tags.length > 0 ? (
        <div className={styles.cardMeta}>
          {projectName ? <span className={styles.cardProject}>{projectName}</span> : null}
          {todo.tags.map((tag) => (
            <span key={tag} className={styles.cardTag}>
              #{tag}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  )
}

/**
 * How many cards a column draws before asking.
 *
 * The done column holds every task ever finished — ninety-odd here — and
 * rendering all of them costs a scroll nobody reads and a repaint on every
 * board update. The rest are one click away.
 */
const VISIBLE_CARDS = 25

type CardState = {
  projectName: string | null
  session: { projectId: string; terminalId: string } | null
  working: boolean
}

function Column({
  status,
  todos,
  stateOf,
  onOpen,
}: {
  status: TodoStatus
  todos: TodoItem[]
  stateOf: (todo: TodoItem) => CardState
  onOpen: (session: { projectId: string; terminalId: string }) => void
}) {
  const t = useT()
  const [showAll, setShowAll] = useState(false)
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN}${status}` })
  const visible = showAll ? todos : todos.slice(0, VISIBLE_CARDS)
  const hidden = todos.length - visible.length

  return (
    <section
      ref={setNodeRef}
      className={`${styles.column} ${isOver ? styles.columnOver : ''}`}
      data-status={status}
    >
      <header className={styles.columnHead}>
        <span className={styles.columnName}>{t(`todo.statusValue.${status}`)}</span>
        <span className={styles.columnCount}>{todos.length}</span>
      </header>
      <div className={styles.columnBody}>
        {visible.map((todo) => {
          const state = stateOf(todo)
          return (
            <Card
              key={todo.id}
              todo={todo}
              projectName={state.projectName}
              session={state.session}
              working={state.working}
              onOpen={state.session ? () => onOpen(state.session!) : undefined}
            />
          )
        })}
        {hidden > 0 ? (
          <button type="button" className={styles.columnMore} onClick={() => setShowAll(true)}>
            {t('board.showMore', { count: hidden })}
          </button>
        ) : null}
        {todos.length === 0 ? <p className={styles.columnEmpty}>{t('board.emptyColumn')}</p> : null}
      </div>
    </section>
  )
}

export function BoardView() {
  const t = useT()
  const todos = useProjectsStore((state) => state.todos)
  const projects = useProjectsStore((state) => state.projects)
  const setTodoStatus = useProjectsStore((state) => state.setTodoStatus)
  const openModal = useUiStore((state) => state.openModal_)
  const focusSession = useSessionFocus()
  const [dragging, setDragging] = useState<TodoItem | null>(null)

  // The same activation distance the sidebar uses, so a click on a card is not
  // read as the start of a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const byStatus = useMemo(() => {
    const grouped = new Map<TodoStatus, TodoItem[]>(TODO_STATUSES.map((status) => [status, []]))
    for (const todo of todos) {
      grouped.get(normalizeTodoStatus(todo.status, todo.completed))?.push(todo)
    }
    return grouped
  }, [todos])

  // One pass over the runtime map for the whole board rather than a store
  // subscription per card: a hundred cards each watching `byPtyId` would
  // repaint the board on every chunk of PTY output.
  const workingPanes = useTerminalsStore((state) => {
    const alive = new Set<string>()
    for (const project of projects) {
      for (const terminal of project.terminals) {
        if (
          terminal.tabs.some((tab) => tab.ptyId && state.byPtyId[tab.ptyId]?.status === 'working')
        )
          alive.add(terminal.id)
      }
    }
    return alive.size ? [...alive].sort().join(' ') : ''
  })

  const stateOf = (todo: TodoItem): CardState => {
    const session = liveSessionOf(todo, projects)
    return {
      projectName: projects.find((project) => project.id === todo.projectId)?.name ?? null,
      session,
      working: Boolean(session && workingPanes.split(' ').includes(session.terminalId)),
    }
  }

  function onDragEnd(event: DragEndEvent) {
    setDragging(null)
    const activeId = String(event.active.id)
    const overId = event.over ? String(event.over.id) : ''
    if (!activeId.startsWith(CARD) || !overId.startsWith(COLUMN)) return

    const todo = todos.find((item) => item.id === activeId.slice(CARD.length))
    if (!todo) return

    const drop = resolveBoardDrop(todo, projects, overId.slice(COLUMN.length) as TodoStatus)
    setTodoStatus(todo.id, drop.move)
    // `stay` keeps the board on screen once the session is running: sorting the
    // board is a batch gesture, and jumping to a terminal after one card ends it.
    if (drop.then === 'offer') openModal('taskSession', { todoId: todo.id, stay: true })
  }

  return (
    <div className={styles.board}>
      <header className={styles.header}>
        <h1 className={styles.title}>{t('board.title')}</h1>
        <p className={styles.subtitle}>{t('board.subtitle')}</p>
      </header>
      <DndContext
        sensors={sensors}
        onDragStart={(event) =>
          setDragging(
            todos.find((item) => item.id === String(event.active.id).slice(CARD.length)) ?? null,
          )
        }
        onDragCancel={() => setDragging(null)}
        onDragEnd={onDragEnd}
      >
        <div className={styles.columns}>
          {TODO_STATUSES.map((status) => (
            <Column
              key={status}
              status={status}
              todos={byStatus.get(status) ?? []}
              stateOf={stateOf}
              onOpen={(session) => focusSession(session.projectId, session.terminalId)}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging ? <div className={styles.dragGhost}>{dragging.title}</div> : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}

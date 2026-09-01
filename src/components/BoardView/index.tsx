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
import { resolveBoardDrop } from '../../lib/boardDrop'
import { useT } from '../../lib/i18n'
import { normalizeTodoPriority, normalizeTodoStatus } from '../../lib/todos'
import { TODO_STATUSES, type TodoItem, type TodoStatus } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './BoardView.module.css'

// The task board.
//
// It owns no state of its own. Columns are `TODO_STATUSES`, moving a card calls
// `setTodoStatus` — the same action the list's status pills call — so the board
// and the sidebar cannot drift: they are two views of one field.

const CARD = 'card:'
const COLUMN = 'col:'

function Card({ todo, projectName }: { todo: TodoItem; projectName: string | null }) {
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
    >
      <span className={styles.cardPriority} data-priority={priority} aria-hidden="true" />
      <p className={styles.cardTitle}>{todo.title}</p>
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

function Column({
  status,
  todos,
  projectNameOf,
}: {
  status: TodoStatus
  todos: TodoItem[]
  projectNameOf: (todo: TodoItem) => string | null
}) {
  const t = useT()
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN}${status}` })

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
        {todos.map((todo) => (
          <Card key={todo.id} todo={todo} projectName={projectNameOf(todo)} />
        ))}
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

  const projectNameOf = (todo: TodoItem) =>
    projects.find((project) => project.id === todo.projectId)?.name ?? null

  function onDragEnd(event: DragEndEvent) {
    setDragging(null)
    const activeId = String(event.active.id)
    const overId = event.over ? String(event.over.id) : ''
    if (!activeId.startsWith(CARD) || !overId.startsWith(COLUMN)) return

    const todo = todos.find((item) => item.id === activeId.slice(CARD.length))
    if (!todo) return

    const drop = resolveBoardDrop(todo, projects, overId.slice(COLUMN.length) as TodoStatus)
    setTodoStatus(todo.id, drop.move)
    if (drop.then === 'focus') focusSession(drop.projectId, drop.terminalId)
    if (drop.then === 'offer') openModal('taskSession', { todoId: todo.id })
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
              projectNameOf={projectNameOf}
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

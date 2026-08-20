import { CircleCheck, Folder, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { buildCliContextInitialInput } from '../../lib/cliContext'
import { pickDirectory } from '../../lib/dialog'
import { useT } from '../../lib/i18n'
import { buildTaskSessionPrompt } from '../../lib/todos'
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  ALL_AGENT_TYPES,
  UNRESTRICTED_FLAG,
  type WorktreeChoice,
} from '../../lib/types'
import { getProjectDefaultCwd, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentIcon } from '../icons/AgentIcons'
import controls from './controls.module.css'
import { Modal } from './Modal'
import styles from './TaskSessionModal.module.css'

/** Pane name derived from the task, so the workspace shows what the session is for. */
const SESSION_NAME_MAX_LENGTH = 40

function sessionName(title: string): string {
  const trimmed = title.trim()
  return trimmed.length > SESSION_NAME_MAX_LENGTH
    ? `${trimmed.slice(0, SESSION_NAME_MAX_LENGTH - 1)}…`
    : trimmed
}

/**
 * Starts an agent session that already knows what it is supposed to do: the task
 * title, tags and notes become the first message, and the resulting pane is linked
 * back to the task.
 */
export function TaskSessionModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'taskSession')
  const context = useUiStore((state) => state.modalContext) as { todoId?: string } | null
  const closeModal = useUiStore((state) => state.closeModal)
  const setActiveView = useUiStore((state) => state.setActiveView)
  const requestPaneFocus = useUiStore((state) => state.requestPaneFocus)
  const setActiveTerminal = useUiStore((state) => state.setActiveTerminal)
  const pushToast = useUiStore((state) => state.pushToast)

  const todo = useProjectsStore((state) =>
    context?.todoId ? (state.todos.find((item) => item.id === context.todoId) ?? null) : null,
  )
  const projects = useProjectsStore((state) => state.projects)
  const activeProjectId = useProjectsStore((state) => state.activeProjectId)
  const enabledAgents = useProjectsStore((state) => state.preferences.enabledAgents)
  const alwaysStartUnrestricted = useProjectsStore(
    (state) => state.preferences.alwaysStartUnrestricted,
  )
  const terminalTheme = useProjectsStore(
    (state) => state.preferences.terminalTheme ?? state.preferences.uiTheme,
  )

  const [projectId, setProjectId] = useState('')
  const [agent, setAgent] = useState<AgentType>('claude')
  const [cwd, setCwd] = useState('')
  const [prompt, setPrompt] = useState('')
  const [isolate, setIsolate] = useState(false)
  const [unrestricted, setUnrestricted] = useState(false)
  const [starting, setStarting] = useState(false)

  const visibleAgents = useMemo(
    () => ALL_AGENT_TYPES.filter((type) => enabledAgents[type]),
    [enabledAgents],
  )
  const project = projects.find((item) => item.id === projectId) ?? null
  const inheritedCwd = useMemo(() => getProjectDefaultCwd(project), [project])

  useEffect(() => {
    if (!open || !todo) return
    const fallbackProject = todo.projectId ?? activeProjectId ?? projects[0]?.id ?? ''
    setProjectId(projects.some((item) => item.id === fallbackProject) ? fallbackProject : '')
    setAgent(visibleAgents.includes('claude') ? 'claude' : (visibleAgents[0] ?? 'shell'))
    setPrompt(buildTaskSessionPrompt(todo))
    setUnrestricted(alwaysStartUnrestricted)
    setIsolate(false)
    setCwd('')
    // Reopening for a different task has to rebuild the whole form, so the task id drives it.
  }, [open, todo?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return
    setIsolate((project?.autoWorktree ?? true) && agent !== 'shell')
  }, [open, project?.autoWorktree, agent])

  const browse = async () => {
    const folder = await pickDirectory({ defaultPath: cwd || inheritedCwd || undefined })
    if (folder) setCwd(folder)
  }

  const start = async () => {
    if (!todo || !project) return
    const store = useProjectsStore.getState()
    const finalCwd = cwd.trim() || inheritedCwd
    const flag = UNRESTRICTED_FLAG[agent]
    const worktree: WorktreeChoice = agent === 'shell' ? 'none' : isolate ? 'new' : 'none'
    setStarting(true)
    try {
      // Codex and OpenCode reject the additive system flag Claude accepts, so
      // the CLI context rides in the first chat message instead. Not as sturdy
      // as a system prompt, but the alternative is the agent not knowing about
      // the task board at all.
      const cliContextPreamble = buildCliContextInitialInput(
        agent,
        useProjectsStore.getState().preferences.cliContextInjection !== false,
      )
      const finalPrompt =
        agent === 'shell'
          ? undefined
          : cliContextPreamble
            ? `${cliContextPreamble}\n\n${prompt.trim()}`.trim() || undefined
            : prompt.trim() || undefined

      const terminal = await store.createAgentTerminal(project.id, {
        name: sessionName(todo.title),
        cwd: finalCwd,
        worktree,
        firstTab: {
          type: agent,
          cwd: finalCwd,
          extraArgs: unrestricted && flag ? [flag] : undefined,
          initialInput: finalPrompt,
        },
      })
      store.linkTodoSession(todo.id, {
        projectId: project.id,
        terminalId: terminal.id,
        agent,
        startedAt: Date.now(),
      })
      if (!todo.projectId) store.setTodoProject(todo.id, project.id)
      store.setActiveProjectOnly(project.id)
      store.focusWorkspaceTerminal(project.id, terminal.id)
      setActiveTerminal(project.id, terminal.id)
      requestPaneFocus(terminal.id)
      setActiveView('workspace')
      closeModal()
    } catch (error) {
      pushToast({
        title: t('taskSession.failedTitle'),
        body: String(error).slice(0, 200),
      })
    } finally {
      setStarting(false)
    }
  }

  return (
    <Modal
      open={open && Boolean(todo)}
      onClose={closeModal}
      title={t('taskSession.title')}
      width={560}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={() => void start()}
            disabled={!project || starting}
          >
            {t('taskSession.start')}
          </button>
        </>
      }
    >
      {todo ? (
        <>
          <p className={styles.taskLine}>
            <span className={styles.taskLabel}>{t('taskSession.forTask')}</span>
            <strong className={styles.taskTitle}>{todo.title}</strong>
          </p>

          <div className={controls.field}>
            <label className={controls.label} htmlFor="task-session-project">
              {t('taskSession.project')}
            </label>
            <select
              id="task-session-project"
              className={controls.input}
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">{t('taskSession.pickProject')}</option>
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>

          <div className={controls.field}>
            <label className={controls.label}>{t('taskSession.agent')}</label>
            <div className={controls.agentGrid}>
              {visibleAgents.map((type) => {
                const active = agent === type
                return (
                  <button
                    key={type}
                    type="button"
                    className={`${controls.agentCard} ${active ? controls.agentCardActive : ''}`}
                    onClick={() => setAgent(type)}
                    aria-pressed={active}
                  >
                    <span className={controls.agentIcon}>
                      <AgentIcon type={type} size={20} theme={terminalTheme} />
                    </span>
                    <span className={controls.agentLabel}>{AGENT_TYPE_LABELS[type]}</span>
                    {active ? <CircleCheck size={16} className={controls.selectedIcon} /> : null}
                  </button>
                )
              })}
            </div>
          </div>

          {agent === 'shell' ? null : (
            <div className={controls.field}>
              <label className={controls.label} htmlFor="task-session-prompt">
                {t('taskSession.prompt')}
              </label>
              <textarea
                id="task-session-prompt"
                className={styles.promptInput}
                value={prompt}
                rows={6}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <span className={controls.hint}>{t('taskSession.promptHint')}</span>
            </div>
          )}

          <div className={controls.field}>
            <label className={controls.label} htmlFor="task-session-cwd">
              {t('taskSession.folder')}
            </label>
            <div className={controls.cwdRow}>
              <div className={controls.cwdInputWrap}>
                <Folder size={14} />
                <input
                  id="task-session-cwd"
                  className={controls.input}
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                  placeholder={inheritedCwd || t('taskSession.folderPlaceholder')}
                />
              </div>
              <button type="button" className={controls.btn} onClick={() => void browse()}>
                {t('taskSession.browse')}
              </button>
            </div>
          </div>

          {agent === 'shell' ? null : (
            <div className={styles.toggles}>
              <label className={controls.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={isolate}
                  onChange={(event) => setIsolate(event.target.checked)}
                />
                <span>{t('taskSession.isolate')}</span>
              </label>
              {UNRESTRICTED_FLAG[agent] ? (
                <label className={controls.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={unrestricted}
                    onChange={(event) => setUnrestricted(event.target.checked)}
                  />
                  <span>
                    <Zap size={14} /> {t('taskSession.unrestricted')}
                  </span>
                </label>
              ) : null}
            </div>
          )}
        </>
      ) : null}
    </Modal>
  )
}

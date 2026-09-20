import { GitBranch, Info } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import { getProjectDefaultCwd, getProjectRepoRoot } from '../../lib/terminalFactory'
import { AGENT_TYPE_LABELS } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import controls from './controls.module.css'
import styles from './NewGroupModal.module.css'

/**
 * Opening a front of work: the name, and whether it gets a worktree of its own.
 *
 * The worktree question belongs here rather than on each session, because the
 * worktree is what the front is: everything running in it edits the same tree,
 * and closing the front is what takes that tree off disk.
 */
export function NewGroupModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'newGroup')
  const context = useUiStore((s) => s.modalContext as { projectId?: string } | null)
  const closeModal = useUiStore((s) => s.closeModal)
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === context?.projectId))
  const createGroup = useProjectsStore((s) => s.createGroup)
  const createAgentTerminal = useProjectsStore((s) => s.createAgentTerminal)
  // `openPane`, not `openTerminalWorkspace`: the latter gives the session a
  // workspace tab of its own, which puts the front's first pane outside the
  // project it belongs to — and makes every later pane look like it opened
  // "in another tab".
  const openPane = useProjectsStore((s) => s.openPane)

  const [name, setName] = useState('')
  const [isolate, setIsolate] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    setName('')
    setIsolate(true)
    setError(null)
    setCreating(false)
    // The name is the whole point of a front, so the caret starts in it.
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  const repoRoot = getProjectRepoRoot(project) || getProjectDefaultCwd(project)

  const submit = async () => {
    const projectId = context?.projectId
    const trimmed = name.trim()
    if (!projectId || !trimmed || creating) return
    setCreating(true)
    setError(null)
    try {
      const group = createGroup(projectId, { name: trimmed })
      // `createAgentTerminal` provisions the worktree and hands back the pane
      // that lives in it; the group takes that worktree as its own, so closing
      // the front is what removes it.
      const orchestrator = await createAgentTerminal(projectId, {
        name: AGENT_TYPE_LABELS.claude,
        cwd: repoRoot,
        worktree: isolate ? 'new' : 'none',
        firstTab: { type: 'claude', cwd: repoRoot },
        groupId: group.id,
        pinned: true,
      })
      if (orchestrator.worktreeAgentId) {
        useProjectsStore.getState().adoptGroupWorktree(projectId, group.id, {
          worktreeAgentId: orchestrator.worktreeAgentId,
          cwd: orchestrator.cwd,
        })
      }
      openPane(projectId, orchestrator.id)
      closeModal()
    } catch (failure) {
      setError(String(failure))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('ui.group.new')}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={() => void submit()}
            disabled={!name.trim() || creating}
          >
            {creating ? t('ui.group.creating') : t('common.create')}
          </button>
        </>
      }
    >
      <div className={controls.field}>
        <label className={controls.label} htmlFor="new-group-name">
          {t('ui.group.nameLabel')}
        </label>
        <input
          id="new-group-name"
          ref={inputRef}
          className={controls.input}
          value={name}
          placeholder={t('ui.group.namePlaceholder')}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
        />
      </div>

      <label className={styles.worktreeToggle}>
        <input
          type="checkbox"
          checked={isolate}
          onChange={(event) => setIsolate(event.target.checked)}
        />
        <span>
          <strong>
            <GitBranch size={13} /> {t('ui.group.isolate')}
          </strong>
          <em>{t('ui.group.isolate.desc')}</em>
        </span>
      </label>

      <div className={styles.hint}>
        <Info size={14} />
        <span>{t('ui.group.orchestratorHint')}</span>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}
    </Modal>
  )
}

import { AlertTriangle, GitBranch } from 'lucide-react'
import { useEffect, useState } from 'react'

import { readableError } from '../../lib/errors'
import { useT } from '../../lib/i18n'
import { gitInit, gitStatus } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import styles from './EditProjectModal.module.css'

export function EditProjectAgentSettings({
  projectId,
  cwd,
  worktreeMode,
  onWorktreeModeChange,
  validationCommandsStr,
  onValidationCommandsChange,
  autoWorktree,
  onAutoWorktreeChange,
  graphifyEnabled,
  onGraphifyEnabledChange,
  gsdWatcherEnabled,
  onGsdWatcherEnabledChange,
}: {
  projectId: string
  cwd: string
  worktreeMode: 'gitWorktree' | 'localCopy'
  onWorktreeModeChange: (mode: 'gitWorktree' | 'localCopy') => void
  validationCommandsStr: string
  onValidationCommandsChange: (value: string) => void
  autoWorktree: boolean
  onAutoWorktreeChange: (enabled: boolean) => void
  graphifyEnabled: boolean
  onGraphifyEnabledChange: (enabled: boolean) => void
  gsdWatcherEnabled: boolean
  onGsdWatcherEnabledChange: (enabled: boolean) => void
}) {
  const t = useT()
  const pushToast = useUiStore((s) => s.pushToast)
  const migrateProjectTerminalsToWorktrees = useProjectsStore(
    (s) => s.migrateProjectTerminalsToWorktrees,
  )

  const [migratingWorktrees, setMigratingWorktrees] = useState(false)

  const [hasGit, setHasGit] = useState<boolean | null>(null)
  const [gitInitBusy, setGitInitBusy] = useState(false)

  useEffect(() => {
    let active = true
    if (!cwd) {
      setHasGit(null)
      return
    }
    gitStatus(cwd)
      .then(() => {
        if (active) setHasGit(true)
      })
      .catch((cause) => {
        if (active) setHasGit(!String(cause).includes('not_a_git_repository'))
      })
    return () => {
      active = false
    }
  }, [cwd])

  const handleInitGit = async () => {
    if (!cwd || gitInitBusy) return
    if (!confirm(t('git.initOffer.confirm'))) return
    setGitInitBusy(true)
    try {
      await gitInit(cwd)
      pushToast({ title: t('git.initOffer.successTitle'), body: t('git.initOffer.successBody') })
      setHasGit(true)
    } catch (cause) {
      pushToast({
        title: t('git.initOffer.failedTitle'),
        body: t('git.initOffer.failedBody', { error: readableError(cause) }),
      })
    } finally {
      setGitInitBusy(false)
    }
  }

  return (
    <>
      <div className={styles.sectionIntro}>
        <h3>{t('crud.editProjectAgentSettings')}</h3>
        <p>{t('crud.editProjectAgentSettingsDesc')}</p>
      </div>

      {hasGit === false ? (
        <div className={controls.gitInitBanner}>
          <span className={controls.gitInitBannerIcon}>
            <AlertTriangle size={16} />
          </span>
          <div className={controls.gitInitBannerText}>
            <strong>{t('git.initOffer.title')}</strong>
            <span>{t('git.initOffer.body')}</span>
          </div>
          <button
            type="button"
            className={controls.gitInitBannerBtn}
            disabled={gitInitBusy}
            onClick={() => void handleInitGit()}
          >
            <GitBranch size={14} />
            {gitInitBusy ? t('git.initOffer.busy') : t('git.initOffer.button')}
          </button>
        </div>
      ) : null}

      <div className={controls.field}>
        <label className={controls.label}>{t('crud.editProjectWorktreeMode')}</label>
        <div className={styles.choiceRow}>
          <label className={styles.choice}>
            <input
              type="radio"
              name="worktreeMode"
              value="gitWorktree"
              checked={worktreeMode === 'gitWorktree'}
              onChange={() => onWorktreeModeChange('gitWorktree')}
            />
            {t('crud.editProjectGitWorktree')}
          </label>
          <label className={styles.choice}>
            <input
              type="radio"
              name="worktreeMode"
              value="localCopy"
              checked={worktreeMode === 'localCopy'}
              onChange={() => onWorktreeModeChange('localCopy')}
            />
            {t('crud.editProjectLocalCopy')}
          </label>
        </div>
      </div>

      <div className={controls.field}>
        <label className={controls.label}>{t('crud.editProjectValidationCommands')}</label>
        <textarea
          className={`${controls.input} ${styles.commandInput}`}
          placeholder={t('crud.editProjectValidationPlaceholder')}
          value={validationCommandsStr}
          onChange={(e) => onValidationCommandsChange(e.target.value)}
        />
      </div>

      <div className={`${controls.field} ${styles.toggleRow}`}>
        <input
          type="checkbox"
          id="autoWorktree"
          checked={autoWorktree}
          onChange={(e) => onAutoWorktreeChange(e.target.checked)}
        />
        <label htmlFor="autoWorktree" className={styles.toggleLabel}>
          {t('multiAgent.autoWorktree')}
        </label>
      </div>

      {/* Migração de terminais JÁ existentes é uma ação explícita e separada
          do toggle acima — o toggle só afeta agentes novos. Migrar os
          existentes mata/suspende o PTY e reinicia o agente do zero na
          worktree nova (sem continuidade de conversa). */}
      <div style={{ marginTop: 4, marginBottom: 4 }}>
        <button
          type="button"
          className={controls.btn}
          disabled={migratingWorktrees}
          onClick={() => {
            if (migratingWorktrees) return
            if (!confirm(t('multiAgent.migrateExistingConfirm'))) return
            setMigratingWorktrees(true)
            void migrateProjectTerminalsToWorktrees(projectId, gsdWatcherEnabled).finally(() =>
              setMigratingWorktrees(false),
            )
          }}
        >
          {migratingWorktrees
            ? t('multiAgent.migrateExistingBusy')
            : t('multiAgent.migrateExisting')}
        </button>
        <p style={{ fontSize: 10, color: 'var(--fg-muted)', marginTop: 4 }}>
          {t('multiAgent.migrateExistingHint')}
        </p>
      </div>

      <div className={`${controls.field} ${styles.toggleRow}`}>
        <input
          type="checkbox"
          id="graphifyEnabled"
          checked={graphifyEnabled}
          onChange={(e) => onGraphifyEnabledChange(e.target.checked)}
        />
        <label htmlFor="graphifyEnabled" className={styles.toggleLabel}>
          {t('project.graphifyEnabled')}
        </label>
      </div>

      <div className={`${controls.field} ${styles.toggleRow}`}>
        <input
          type="checkbox"
          id="gsdWatcher"
          checked={gsdWatcherEnabled}
          onChange={(e) => onGsdWatcherEnabledChange(e.target.checked)}
        />
        <label htmlFor="gsdWatcher" className={styles.toggleLabel}>
          {t('crud.editProjectGsdWatcher')}
        </label>
      </div>
    </>
  )
}

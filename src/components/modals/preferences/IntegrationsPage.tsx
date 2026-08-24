import { useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import {
  cliShimInstall,
  type CliShimStatus,
  cliShimStatus,
  cliShimUninstall,
} from '../../../lib/tauri'
import { useProjectsStore } from '../../../stores/projectsStore'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'
import { ShortcutField } from './ShortcutField'
import { SpeechModelPicker } from './SpeechModelPicker'

function TerminalCommandSection() {
  const t = useT()
  const [status, setStatus] = useState<CliShimStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    void cliShimStatus()
      .then((next) => {
        if (!disposed) setStatus(next)
      })
      .catch(() => {
        if (!disposed) setStatus(null)
      })
    return () => {
      disposed = true
    }
  }, [])

  const run = async (action: () => Promise<CliShimStatus>) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await action())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      id="terminal-command"
      title={t('prefs.cliCommand')}
      description={t('prefs.cliCommandDesc')}
    >
      <div className={styles.integrationFields}>
        <pre className={styles.cliUsage}>
          <code>{'arco\narco .\narco ~/meu-projeto'}</code>
        </pre>

        {status?.supported === false ? (
          <p>{t('prefs.cliUnsupported')}</p>
        ) : (
          <>
            <div className={styles.cliActions}>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnPrimary}`}
                disabled={busy || !status}
                onClick={() => void run(cliShimInstall)}
              >
                {status?.installed ? t('prefs.cliReinstall') : t('prefs.cliInstall')}
              </button>
              {status?.installed ? (
                <button
                  type="button"
                  className={`${controls.btn} ${controls.btnDanger}`}
                  disabled={busy}
                  onClick={() => void run(cliShimUninstall)}
                >
                  {t('prefs.cliUninstall')}
                </button>
              ) : null}
            </div>

            {status?.installed && status.path ? (
              <p className={styles.cliPath}>{t('prefs.cliInstalledAt', { path: status.path })}</p>
            ) : null}

            {status?.stale ? <p className={styles.cliWarning}>{t('prefs.cliStale')}</p> : null}

            {status?.installed && !status.onPath && status.binDir ? (
              <p className={styles.cliWarning}>{t('prefs.cliNotOnPath', { dir: status.binDir })}</p>
            ) : null}

            {error ? <p className={styles.cliWarning}>{error}</p> : null}
          </>
        )}
      </div>
    </SettingsSection>
  )
}

export function IntegrationsPage() {
  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  return (
    <>
      <TerminalCommandSection />

      <SettingsSection
        id="cli-context"
        title={t('prefs.cliContext')}
        description={t('prefs.cliContextDesc')}
      >
        <div className={styles.segmented}>
          <button
            type="button"
            className={preferences.cliContextInjection !== false ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ cliContextInjection: true })}
          >
            {t('prefs.cliContextOn')}
          </button>
          <button
            type="button"
            className={preferences.cliContextInjection === false ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ cliContextInjection: false })}
          >
            {t('prefs.cliContextOff')}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="dictation"
        title={t('prefs.dictation')}
        description={t('prefs.dictationDesc')}
      >
        <div className={styles.segmented}>
          <button
            type="button"
            className={preferences.dictationEnabled ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ dictationEnabled: true })}
          >
            {t('prefs.dictationOn')}
          </button>
          <button
            type="button"
            className={!preferences.dictationEnabled ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ dictationEnabled: false })}
          >
            {t('prefs.dictationOff')}
          </button>
        </div>
        {preferences.dictationEnabled ? (
          <>
            <p>{t('prefs.dictationModeDesc')}</p>
            <div className={styles.segmented}>
              <button
                type="button"
                className={
                  (preferences.dictationMode ?? 'hold') === 'hold'
                    ? styles.segmentActive
                    : undefined
                }
                onClick={() => setPreferences({ dictationMode: 'hold' })}
              >
                {t('prefs.dictationModeHold')}
              </button>
              <button
                type="button"
                className={
                  preferences.dictationMode === 'toggle' ? styles.segmentActive : undefined
                }
                onClick={() => setPreferences({ dictationMode: 'toggle' })}
              >
                {t('prefs.dictationModeToggle')}
              </button>
            </div>

            <div className={controls.field}>
              <label className={controls.label}>{t('prefs.dictationShortcut')}</label>
              <ShortcutField
                value={preferences.dictationShortcut}
                onChange={(dictationShortcut) => setPreferences({ dictationShortcut })}
              />
              <span className={controls.hint}>{t('prefs.dictationShortcutDesc')}</span>
            </div>

            <div className={controls.field}>
              <label className={controls.label}>{t('prefs.dictationModel')}</label>
              <span className={controls.hint}>{t('prefs.dictationModelDesc')}</span>
              <SpeechModelPicker
                value={preferences.dictationModel}
                onChange={(dictationModel) => setPreferences({ dictationModel })}
              />
            </div>
          </>
        ) : null}
      </SettingsSection>
    </>
  )
}

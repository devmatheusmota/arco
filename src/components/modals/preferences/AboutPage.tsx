import { getVersion } from '@tauri-apps/api/app'
import { DownloadCloud, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { checkForUpdate, installPendingUpdate } from '../../../lib/updater'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

export function AboutPage() {
  const t = useT()
  const updateInfo = useUiStore((state) => state.updateInfo)
  const setUpdateInfo = useUiStore((state) => state.setUpdateInfo)
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [checkedUpToDate, setCheckedUpToDate] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'installing' | 'error'>('idle')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(''))
  }, [])

  const onCheck = async () => {
    if (checking) return
    setChecking(true)
    setCheckedUpToDate(false)
    setError('')
    try {
      const info = await checkForUpdate()
      setUpdateInfo(info)
      if (!info) setCheckedUpToDate(true)
    } catch (err) {
      setError(String(err))
    } finally {
      setChecking(false)
    }
  }

  const onInstall = async () => {
    setPhase('installing')
    setError('')
    try {
      await installPendingUpdate(({ downloaded, total }) => {
        setPercent(total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0)
      })
    } catch (err) {
      setPhase('error')
      setError(String(err))
    }
  }

  const installing = phase === 'installing'

  return (
    <>
      <SettingsSection
        id="app-version"
        title={t('prefs.aboutVersionTitle')}
        description={t('prefs.aboutVersionDesc')}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 14px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)',
            background: 'var(--bg-sunken)',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <strong style={{ fontSize: 14 }}>Arco</strong>
            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>com.mota.arco</span>
          </div>
          <span
            style={{
              fontSize: 15,
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--fg)',
            }}
          >
            {version ? `v${version}` : '—'}
          </span>
        </div>
      </SettingsSection>

      <SettingsSection
        id="app-updates"
        title={t('prefs.aboutUpdatesTitle')}
        description={t('prefs.aboutUpdatesDesc')}
      >
        {updateInfo ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <DownloadCloud size={16} style={{ color: 'var(--status-working)', flexShrink: 0 }} />
              <span>
                {t('prefs.aboutUpdateAvailable', {
                  version: updateInfo.version,
                  current: updateInfo.currentVersion,
                })}
              </span>
            </div>
            {updateInfo.notes ? (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--fg-muted)',
                  whiteSpace: 'pre-wrap',
                  maxHeight: 160,
                  overflowY: 'auto',
                  padding: '8px 10px',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-active)',
                }}
              >
                {updateInfo.notes}
              </div>
            ) : null}
            {installing ? (
              <div
                style={{
                  height: 6,
                  borderRadius: 3,
                  background: 'var(--bg-active)',
                  overflow: 'hidden',
                }}
                aria-hidden
              >
                <div
                  style={{
                    height: '100%',
                    width: `${percent}%`,
                    background: 'var(--accent)',
                    transition: 'width 0.2s ease',
                  }}
                />
              </div>
            ) : null}
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              onClick={() => void onInstall()}
              disabled={installing}
              style={{ alignSelf: 'flex-start' }}
            >
              {installing ? t('update.installing', { percent }) : t('update.installNow')}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void onCheck()}
              disabled={checking}
              style={{ alignSelf: 'flex-start' }}
            >
              <RotateCcw size={15} />
              {checking ? t('prefs.aboutChecking') : t('prefs.aboutCheckUpdates')}
            </button>
            {checkedUpToDate ? (
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                {t('prefs.aboutUpToDate', { version })}
              </span>
            ) : null}
          </div>
        )}
        {error ? (
          <p
            style={{
              fontSize: 12,
              color: 'var(--status-failed-fg, #ef4444)',
              marginTop: 8,
              wordBreak: 'break-word',
            }}
          >
            {t('update.error', { error })}
          </p>
        ) : null}
      </SettingsSection>
    </>
  )
}

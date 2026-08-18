import { listen } from '@tauri-apps/api/event'
import { Check, Download, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import {
  dictationDelete,
  dictationDownload,
  dictationModels,
  type DownloadProgress,
  type SpeechModel,
} from '../../../lib/tauri'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'

type Props = {
  value: string | undefined
  onChange: (id: string) => void
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 / 1024)} MB`
}

export function SpeechModelPicker({ value, onChange }: Props) {
  const t = useT()
  const [models, setModels] = useState<SpeechModel[] | null>(null)
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    void dictationModels()
      .then(setModels)
      .catch(() => setModels([]))
  }, [])

  useEffect(load, [load])

  // Progress arrives from the backend while a download runs; the list is
  // refreshed once at the end so `installed` reflects the finished files.
  useEffect(() => {
    const pending = listen<DownloadProgress>('dictation://download', (event) => {
      const update = event.payload
      setProgress((current) => ({ ...current, [update.id]: update }))
      if (update.done) {
        setBusy(null)
        load()
      }
    })
    return () => {
      void pending.then((dispose) => dispose())
    }
  }, [load])

  if (!models) return <p>{t('loading.initializing')}</p>

  return (
    <div className={styles.integrationFields}>
      {models.map((model) => {
        const active = model.id === value
        const running = progress[model.id]
        const downloading = busy === model.id && !running?.done
        const percent =
          running && running.total > 0 ? Math.round((running.received / running.total) * 100) : 0

        return (
          <div key={model.id} className={styles.modelRow}>
            <div>
              <strong>{model.label}</strong>{' '}
              <span className={controls.hint}>
                {formatSize(model.sizeBytes)} · {model.language}
                {model.streaming ? ` · ${t('prefs.modelStreaming')}` : ''}
                {model.recommended ? ` · ${t('prefs.modelRecommended')}` : ''}
              </span>
              <p className={controls.hint}>{model.description}</p>
              {model.streaming ? (
                <p className={styles.cliWarning}>{t('prefs.modelUnsupported')}</p>
              ) : null}
              {downloading ? (
                <p className={controls.hint}>
                  {t('prefs.modelDownloading', { percent, file: running?.file ?? '' })}
                </p>
              ) : null}
              {running?.error ? <p className={styles.cliWarning}>{running.error}</p> : null}
            </div>

            <div className={styles.cliActions}>
              {model.installed ? (
                <>
                  <button
                    type="button"
                    className={`${controls.btn} ${active ? controls.btnPrimary : ''}`}
                    disabled={active || model.streaming}
                    onClick={() => onChange(model.id)}
                  >
                    {active ? <Check size={13} /> : null}
                    {active ? t('prefs.modelActive') : t('prefs.modelUse')}
                  </button>
                  <button
                    type="button"
                    className={`${controls.btn} ${controls.btnDanger}`}
                    disabled={active}
                    title={active ? t('prefs.modelDeleteActive') : undefined}
                    onClick={() => {
                      void dictationDelete(model.id).then(load)
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={controls.btn}
                  disabled={downloading || model.streaming}
                  onClick={() => {
                    setBusy(model.id)
                    void dictationDownload(model.id).catch(() => setBusy(null))
                  }}
                >
                  <Download size={13} />
                  {downloading ? `${percent}%` : t('prefs.modelDownload')}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

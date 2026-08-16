import { Mic, Square } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import styles from './DictationOverlay.module.css'

type Props = {
  /** Elapsed time is measured from here, not from mount, so it survives a rerender. */
  startedAt: number
  onStop: () => void
}

/**
 * Shown while dictation is capturing.
 *
 * The button icon alone was the only feedback, which is invisible unless you are
 * looking at it — and dictation is used while looking at the pane. This floats
 * above the workspace so the state is unmissable, and gives a way out with the
 * mouse when the shortcut is held down wrong.
 */
export function DictationOverlay({ startedAt, onStop }: Props) {
  const t = useT()
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    tick()
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [startedAt])

  const minutes = Math.floor(elapsed / 60)
  const seconds = elapsed % 60

  return (
    <div className={styles.overlay} role="status" aria-live="polite">
      <span className={styles.pulse} aria-hidden>
        <Mic size={14} />
      </span>
      <span className={styles.label}>{t('dictation.listening')}</span>
      <span className={styles.timer}>
        {minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`}
      </span>
      <button type="button" className={styles.stop} onClick={onStop} title={t('dictation.stop')}>
        <Square size={11} fill="currentColor" />
      </button>
    </div>
  )
}

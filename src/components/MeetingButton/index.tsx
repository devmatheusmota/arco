import { Radio } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import { meetingStart, type MeetingStatus, meetingStatus, meetingStop } from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import styles from './MeetingButton.module.css'

/**
 * Starts and stops the meeting transcription.
 *
 * The recording belongs to `meetscribe`, not to Arco: it keeps writing while the
 * app is closed, and the button reads its state back rather than keeping one of
 * its own. That is why the clock starts from the moment this window first saw
 * the capture running — Arco does not know when a recording it did not start
 * began, and a made-up number would be worse than an honest one.
 */

/** Often enough to notice a capture that died, rare enough to cost nothing. */
const POLL_MS = 15_000

function elapsedLabel(since: number): string {
  const minutes = Math.floor((Date.now() - since) / 60_000)
  if (minutes < 60) return `${minutes}min`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}

export function MeetingButton() {
  const t = useT()
  const [state, setState] = useState<MeetingStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Re-rendered by the poll and by every toggle; the clock only needs to be
  // roughly right, and a timer per minute is a wake-up the terminal can keep.
  const [, setTick] = useState(0)
  const sinceRef = useRef(0)

  const read = useCallback(async () => {
    try {
      const next = await meetingStatus()
      setState((previous) => {
        if (next.recording && !previous?.recording) sinceRef.current = Date.now()
        if (!next.recording) sinceRef.current = 0
        return next
      })
    } catch {
      // The transcription is a convenience: a status that fails must not take
      // the button, or the window, with it.
    }
  }, [])

  useEffect(() => {
    void read()
    const timer = window.setInterval(() => void read(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [read])

  useEffect(() => {
    if (!state?.recording) return
    const timer = window.setInterval(() => setTick((value) => value + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [state?.recording])

  const toggle = useCallback(async () => {
    if (busy || !state?.available) return
    setBusy(true)
    setError(null)
    try {
      if (!state.recording) {
        const next = await meetingStart()
        sinceRef.current = Date.now()
        setState(next)
        return
      }
      const { file } = await meetingStop()
      await read()
      useUiStore.getState().pushToast({
        title: t('meeting.savedTitle'),
        body: file ? t('meeting.savedBody', { file }) : t('meeting.savedNoFile'),
      })
    } catch (failure) {
      // A silent failure reads as "it recorded". The button says otherwise, and
      // the reason stays in the tooltip where it can be read without a toast.
      setError(
        String(failure)
          .replace(/^Error:\s*/, '')
          .slice(0, 300),
      )
      await read()
    } finally {
      setBusy(false)
    }
  }, [busy, state, read, t])

  // Nothing to offer on a machine without meetscribe, and a dead button in the
  // corner is worse than no button.
  if (!state?.available) return null

  const recording = state.recording
  const label = recording
    ? t('meeting.recording', { elapsed: elapsedLabel(sinceRef.current || Date.now()) })
    : error
      ? t('meeting.failed')
      : t('meeting.idle')

  const title = [
    recording ? t('meeting.stopHint') : t('meeting.startHint'),
    state.warning ? t('meeting.warning', { warning: state.warning }) : null,
    error ? t('meeting.lastError', { error }) : null,
    !recording && state.pending > 0 ? t('meeting.pending', { count: state.pending }) : null,
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <button
      type="button"
      className={[styles.btn, recording ? styles.recording : '', error ? styles.failed : '']
        .filter(Boolean)
        .join(' ')}
      onClick={() => void toggle()}
      disabled={busy}
      title={title}
      aria-label={t('meeting.label')}
      aria-pressed={recording}
    >
      {recording ? <span className={styles.dot} aria-hidden="true" /> : <Radio size={16} />}
      <span className={recording ? styles.clock : undefined}>{label}</span>
    </button>
  )
}

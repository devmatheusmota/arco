import { Mic, MicOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import {
  dictationCancel,
  dictationPreload,
  dictationStart,
  dictationStatus,
  dictationStop,
  writePty,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './DictationButton.module.css'

/** Transcribe speech into the active terminal when dictation is enabled. */

/** Hold shorter than this reads as a mistap, not an attempt to dictate. */
const MIN_HOLD_MS = 250

/** Active terminal PTY, if any. */
function activePtyId(): string | null {
  const target = useUiStore.getState().activeTerminal
  if (!target) return null
  const project = useProjectsStore.getState().projects.find((p) => p.id === target.projectId)
  const terminal = project?.terminals.find((t) => t.id === target.terminalId)
  const tab = terminal?.tabs.find((t) => t.id === terminal.activeTabId) ?? terminal?.tabs[0]
  return tab?.ptyId ?? null
}

export function DictationButton() {
  const t = useT()
  const enabled = useProjectsStore((s) => s.preferences.dictationEnabled)
  const mode = useProjectsStore((s) => s.preferences.dictationMode) ?? 'hold'
  const [listening, setListening] = useState(false)
  const [modelFound, setModelFound] = useState<boolean | null>(null)
  const startedAtRef = useRef(0)
  // Guards the async gap: releasing the key before dictation_start resolves must
  // not leave the microphone open with no way to stop it.
  const pendingStopRef = useRef(false)

  // Probe the model once, and warm it so the first hold does not pay the 622 MB load.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void dictationStatus()
      .then((status) => {
        if (cancelled) return
        setModelFound(status.modelFound)
        if (status.modelFound && !status.modelLoaded) void dictationPreload().catch(() => {})
      })
      .catch(() => {
        if (!cancelled) setModelFound(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  const start = useCallback(async () => {
    if (listening) return
    pendingStopRef.current = false
    startedAtRef.current = Date.now()
    setListening(true)
    try {
      await dictationStart()
    } catch (error) {
      console.warn('[dictation] start failed:', error)
      setListening(false)
      return
    }
    if (pendingStopRef.current) {
      pendingStopRef.current = false
      void stop()
    }
  }, [listening])

  const stop = useCallback(async () => {
    setListening(false)
    // Too short to carry speech: drop the audio instead of paying a decode for it.
    if (Date.now() - startedAtRef.current < MIN_HOLD_MS) {
      await dictationCancel().catch(() => {})
      return
    }
    try {
      const text = (await dictationStop()).trim()
      const ptyId = activePtyId()
      if (text && ptyId) await writePty(ptyId, `${text} `)
    } catch (error) {
      console.warn('[dictation] stop failed:', error)
    }
  }, [])

  // Ctrl+E drives dictation from any focused pane, matching the shortcut muscle
  // memory. Hold dictates while held; toggle flips on each press.
  useEffect(() => {
    if (!enabled || modelFound === false) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'e') return
      if (event.altKey || event.shiftKey) return
      event.preventDefault()
      event.stopPropagation()
      if (mode === 'toggle') {
        void (listening ? stop() : start())
        return
      }
      // Key repeat fires while held; only the first press opens the microphone.
      if (!event.repeat && !listening) void start()
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (mode !== 'hold') return
      // Releasing Ctrl first reports key 'e' with ctrlKey already false, so match
      // on either half of the chord.
      const key = event.key.toLowerCase()
      if (key !== 'e' && key !== 'control' && key !== 'meta') return
      if (!listening) {
        pendingStopRef.current = true
        return
      }
      void stop()
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [enabled, modelFound, mode, listening, start, stop])

  // Never leave the microphone open behind an unmount or a disabled toggle.
  useEffect(
    () => () => {
      void dictationCancel().catch(() => {})
    },
    [],
  )

  if (!enabled) return null

  const supported = modelFound !== false

  return (
    <button
      type="button"
      className={`${styles.btn} ${listening ? styles.listening : ''}`}
      onPointerDown={mode === 'hold' ? () => void start() : undefined}
      onPointerUp={mode === 'hold' ? () => void stop() : undefined}
      onPointerLeave={mode === 'hold' && listening ? () => void stop() : undefined}
      onClick={mode === 'toggle' ? () => void (listening ? stop() : start()) : undefined}
      disabled={!supported}
      title={
        !supported
          ? t('dictation.modelMissing')
          : listening
            ? t('dictation.stop')
            : t('dictation.start')
      }
      aria-label={t('dictation.label')}
      aria-pressed={listening}
    >
      {listening ? <Mic size={18} /> : <MicOff size={18} />}
    </button>
  )
}

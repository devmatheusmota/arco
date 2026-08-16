import { useEffect, useRef, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { shortcutFromEvent, shortcutLabel } from '../../../lib/shortcut'
import controls from '../controls.module.css'

type Props = {
  value: string | undefined
  onChange: (shortcut: string) => void
}

/**
 * Records a chord by listening instead of asking the user to type its name.
 *
 * While recording it swallows every key, including the app's own shortcuts —
 * otherwise pressing Ctrl+T to bind it would open a terminal instead.
 */
export function ShortcutField({ value, onChange }: Props) {
  const t = useT()
  const [recording, setRecording] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!recording) return

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        return
      }
      const shortcut = shortcutFromEvent(event)
      // Null while only modifiers are down: keep waiting for the real key.
      if (!shortcut) return
      onChange(shortcut)
      setRecording(false)
    }

    // Capture phase, so the global keybinding handler never sees these.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, onChange])

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`${controls.btn} ${recording ? controls.btnPrimary : ''}`}
      onClick={() => setRecording((current) => !current)}
      onBlur={() => setRecording(false)}
      aria-label={t('prefs.shortcutRecordLabel')}
    >
      {recording ? t('prefs.shortcutRecording') : shortcutLabel(value)}
    </button>
  )
}

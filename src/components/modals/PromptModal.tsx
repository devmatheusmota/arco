import { useEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import type { PromptRequest } from '../../stores/uiStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import { Modal } from './Modal'

type FormProps = {
  request: PromptRequest
  onSubmit: (value: string) => void
  onCancel: () => void
}

/**
 * Mounted fresh per question — keyed on the request id.
 *
 * The value has to be there on the first render: the dialog selects it so that
 * typing replaces the old name, and a value arriving one render later would be
 * selected while the field is still empty, leaving the caret at the end and the
 * old text in place.
 */
function PromptForm({ request, onSubmit, onCancel }: FormProps) {
  const t = useT()
  const [value, setValue] = useState(request.initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  // A frame late on purpose: the dialog moves focus to the field itself while
  // it opens, and selecting before that runs leaves the caret at the end with
  // the old name still in the way.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      input.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed && !request.allowEmpty) return
    onSubmit(trimmed)
  }

  return (
    <Modal
      open
      onClose={onCancel}
      title={request.title}
      width={420}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={submit}
            disabled={!value.trim() && !request.allowEmpty}
          >
            {request.confirmLabel ?? t('common.confirm')}
          </button>
        </>
      }
    >
      <div className={controls.field}>
        {request.label ? <label className={controls.label}>{request.label}</label> : null}
        <input
          ref={inputRef}
          className={controls.input}
          value={value}
          placeholder={request.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
        />
      </div>
    </Modal>
  )
}

/**
 * The app's own text prompt, standing in for `window.prompt` — which Electron
 * does not implement, so every caller that used it silently did nothing.
 */
export function PromptModal() {
  const request = useUiStore((state) => state.promptRequest)
  const resolvePrompt = useUiStore((state) => state.resolvePrompt)

  if (!request) return null
  return (
    <PromptForm
      key={request.id}
      request={request}
      onSubmit={(value) => resolvePrompt(value)}
      onCancel={() => resolvePrompt(null)}
    />
  )
}

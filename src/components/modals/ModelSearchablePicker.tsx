import { ChevronDown, Search, Check, Sparkles } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'

import { useT } from '../../lib/i18n'
import styles from './ModelSearchablePicker.module.css'

export type ModelOption = {
  id: string
  label: string
}

export type ModelSearchablePickerProps = {
  /** An empty value means the agent picks its own default model. */
  value: string
  onChange: (modelId: string) => void
  options: ModelOption[]
  loading?: boolean
  providerName: string
}

export function ModelSearchablePicker({
  value,
  onChange,
  options,
  loading,
  providerName,
}: ModelSearchablePickerProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Drop lines a CLI printed as help or error text instead of model names.
  const cleanOptions = options.filter(
    (opt) =>
      opt.id &&
      !opt.id.startsWith('-') &&
      !opt.id.startsWith('#') &&
      !opt.id.toLowerCase().startsWith('could') &&
      !opt.id.toLowerCase().startsWith('usage') &&
      !opt.id.toLowerCase().startsWith('error') &&
      !opt.id.toLowerCase().startsWith('let') &&
      opt.id.length >= 3,
  )

  const selected = value
    ? (cleanOptions.find((opt) => opt.id === value) ?? { id: value, label: value })
    : null

  const trimmedSearch = search.trim()
  const filteredOptions = cleanOptions.filter(
    (opt) =>
      opt.label.toLowerCase().includes(trimmedSearch.toLowerCase()) ||
      opt.id.toLowerCase().includes(trimmedSearch.toLowerCase()),
  )

  const hasExactMatch = cleanOptions.some(
    (opt) =>
      opt.id.toLowerCase() === trimmedSearch.toLowerCase() ||
      opt.label.toLowerCase() === trimmedSearch.toLowerCase(),
  )
  const showCustomOption = trimmedSearch.length >= 2 && !hasExactMatch
  const showDefaultOption = trimmedSearch.length === 0

  const selectOption = (modelId: string) => {
    onChange(modelId)
    setOpen(false)
    setSearch('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (filteredOptions.length > 0) {
        selectOption(filteredOptions[0].id)
      } else if (showCustomOption) {
        selectOption(trimmedSearch)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div className={styles.wrapper} ref={containerRef}>
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerActive : ''}`}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <Sparkles size={14} color="var(--accent)" style={{ flexShrink: 0 }} />
          <span className={styles.triggerText}>
            {loading && !selected
              ? t('modelPicker.loading')
              : selected
                ? selected.label
                : t('modelPicker.default')}
          </span>
        </span>
        <ChevronDown size={14} style={{ flexShrink: 0, opacity: 0.7 }} />
      </button>

      {open && (
        <div className={styles.dropdown}>
          <div className={styles.searchBox}>
            <Search size={14} color="var(--fg-muted)" />
            <input
              type="text"
              placeholder={
                cleanOptions.length > 0
                  ? t('modelPicker.search', { count: cleanOptions.length, provider: providerName })
                  : t('modelPicker.typeModel')
              }
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
          </div>

          <div className={styles.optionsList}>
            {showDefaultOption && (
              <button
                type="button"
                className={`${styles.optionItem} ${!value ? styles.optionItemActive : ''}`}
                onClick={() => selectOption('')}
              >
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontWeight: !value ? 600 : 400 }}>{t('modelPicker.default')}</span>
                  <span className={styles.optionHint}>
                    {t('modelPicker.defaultHint', { provider: providerName })}
                  </span>
                </div>
                {!value ? <Check size={14} color="var(--accent)" /> : null}
              </button>
            )}

            {filteredOptions.length === 0 && !showCustomOption && !showDefaultOption ? (
              <div className={styles.emptyState}>
                {t('modelPicker.empty', { query: trimmedSearch })}
              </div>
            ) : (
              <>
                {filteredOptions.map((opt) => {
                  const isSelected = opt.id === value
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={`${styles.optionItem} ${isSelected ? styles.optionItemActive : ''}`}
                      onClick={() => selectOption(opt.id)}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span style={{ fontWeight: isSelected ? 600 : 400 }}>{opt.label}</span>
                        <span className={styles.modelId}>{opt.id}</span>
                      </div>
                      {isSelected ? <Check size={14} color="var(--accent)" /> : null}
                    </button>
                  )
                })}

                {showCustomOption && (
                  <button
                    type="button"
                    className={styles.optionItem}
                    onClick={() => selectOption(trimmedSearch)}
                    style={{ borderTop: '1px dashed var(--border)', marginTop: 4, paddingTop: 6 }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span style={{ fontWeight: 600, color: 'var(--accent)' }}>
                        {t('modelPicker.custom', { model: trimmedSearch })}
                      </span>
                      <span className={styles.modelId}>{trimmedSearch}</span>
                    </div>
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

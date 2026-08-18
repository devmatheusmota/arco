import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useOnClickOutside } from '../../hooks/useOnClickOutside'
import { useOnEscape } from '../../hooks/useOnEscape'
import styles from './ContextMenu.module.css'

export type MenuItem =
  | { kind: 'item'; label: string; onClick: () => void; danger?: boolean; icon?: ReactNode }
  | { kind: 'separator' }

type Props = {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })
  // Where focus came from, so closing the menu puts it back instead of dropping
  // the user at the top of the document.
  const opener = useRef<HTMLElement | null>(null)

  useOnClickOutside(ref, onClose)
  useOnEscape(onClose)

  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const margin = 8
    const rect = menu.getBoundingClientRect()
    setPosition({
      x: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin)),
    })
  }, [items, x, y])

  useLayoutEffect(() => {
    // The menu announced itself as one (role="menu") but never took focus, so
    // none of the keys a menu is expected to answer to did anything.
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    return () => opener.current?.focus()
  }, [])

  const move = (from: HTMLElement, step: number) => {
    const entries = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    )
    if (entries.length === 0) return
    const index = entries.indexOf(from as HTMLButtonElement)
    const next = (index + step + entries.length) % entries.length
    entries[next]?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const entries = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    )
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(target, 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(target, -1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      entries[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      entries[entries.length - 1]?.focus()
    } else if (event.key === 'Tab') {
      // Tabbing out of a context menu means dismissing it, not walking into
      // whatever happens to be behind it.
      event.preventDefault()
      onClose()
    }
  }

  return createPortal(
    <div
      ref={ref}
      className={styles.menu}
      style={{ left: position.x, top: position.y }}
      role="menu"
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) =>
        item.kind === 'separator' ? (
          <div key={i} className={styles.separator} role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`${styles.item} ${item.danger ? styles.danger : ''}`}
            onClick={() => {
              item.onClick()
              onClose()
            }}
          >
            {item.icon ? <span className={styles.itemIcon}>{item.icon}</span> : null}
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}

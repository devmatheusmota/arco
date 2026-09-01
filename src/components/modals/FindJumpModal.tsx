import { Bot, Boxes, Code2, Gift, type LucideIcon, Sparkles, Terminal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { peekCachedChatTitle } from '../../hooks/useSidebarChatTitle'
import { useT } from '../../lib/i18n'
import { sessionDisplayLabel } from '../../lib/sessionLabel'
import type { AgentType } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import { Modal } from './Modal'

const ICONS: Record<AgentType, LucideIcon> = {
  shell: Terminal,
  claude: Sparkles,
  codex: Code2,
  copilot: Bot,
  antigravity: Sparkles,
  opencode: Boxes,
  freebuff: Gift,
  mimo: Bot,
}

type Hit = {
  projectId: string
  projectName: string
  terminalId: string
  /** What the sidebar shows for this pane. */
  terminalName: string
  /** The stored name, still searchable so a rename finds its pane either way. */
  rawName: string
  lastUsedAt: number
  type: AgentType
  cwd: string
}

export function FindJumpModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'findJump')
  const closeModal = useUiStore((s) => s.closeModal)
  const projects = useProjectsStore((s) => s.projects)
  const openTerminalWorkspace = useProjectsStore((s) => s.openTerminalWorkspace)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)

      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const hits = useMemo<Hit[]>(() => {
    const all: Hit[] = projects.flatMap((p) =>
      p.terminals.map((term) => {
        const active = term.tabs.find((s) => s.id === term.activeTabId) ?? term.tabs[0]
        return {
          projectId: p.id,
          projectName: p.name,
          terminalId: term.id,
          // The same name the sidebar draws. Searching `term.name` while the
          // sidebar showed the conversation title meant reading a name on
          // screen, typing it here, and finding nothing.
          terminalName: sessionDisplayLabel(term, peekCachedChatTitle(active)) || term.name,
          rawName: term.name,
          lastUsedAt: term.lastUsedAt ?? 0,
          type: active?.type ?? 'shell',
          cwd: active?.cwd ?? term.cwd,
        }
      }),
    )
    // Most recent first. The sidebar deliberately keeps its own order — a tree
    // that reshuffles as you work destroys the memory of where things were —
    // so this is where "the one I was just in" belongs.
    all.sort((a, b) => b.lastUsedAt - a.lastUsedAt)

    const q = query.trim().toLowerCase()
    if (!q) return all.slice(0, 50)
    return all
      .filter((h) =>
        `${h.projectName} ${h.terminalName} ${h.rawName} ${h.cwd}`.toLowerCase().includes(q),
      )
      .slice(0, 50)
  }, [projects, query])

  const jump = (hit: Hit) => {
    openTerminalWorkspace(hit.projectId, hit.terminalId)
    useUiStore.getState().setActiveView('workspace')
    useUiStore.getState().requestPaneFocus(hit.terminalId)
    closeModal()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, hits.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = hits[cursor]
      if (hit) jump(hit)
    }
  }

  return (
    <Modal open={open} onClose={closeModal} title={t('term.findTerminalTitle')} width={520}>
      <input
        ref={inputRef}
        className={controls.input}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setCursor(0)
        }}
        onKeyDown={onKey}
        placeholder={t('term.findPlaceholder')}
        autoFocus
      />

      <div style={{ marginTop: 12, maxHeight: 320, overflowY: 'auto' }}>
        {hits.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-faint)' }}>
            {t('term.nothingFound')}
          </div>
        ) : (
          hits.map((hit, i) => {
            const Icon = ICONS[hit.type]
            const active = i === cursor
            return (
              <button
                key={`${hit.projectId}:${hit.terminalId}`}
                type="button"
                onClick={() => jump(hit)}
                onMouseEnter={() => setCursor(i)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-sm)',
                  background: active ? 'var(--accent-faint)' : 'transparent',
                  color: 'var(--fg)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                <Icon size={14} />
                <span style={{ fontWeight: 500 }}>{hit.terminalName}</span>
                <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>· {hit.projectName}</span>
                {hit.cwd ? (
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 10,
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--fg-faint)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: 220,
                    }}
                    title={hit.cwd}
                  >
                    {hit.cwd}
                  </span>
                ) : null}
              </button>
            )
          })
        )}
      </div>
    </Modal>
  )
}

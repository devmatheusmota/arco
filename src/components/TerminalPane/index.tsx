import {
  ArrowRightLeft,
  Check,
  Clock,
  Maximize2,
  Minimize2,
  Pin,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { usePaneTaskTitle } from '../../hooks/usePaneTaskTitle'
import { useSidebarChatTitle } from '../../hooks/useSidebarChatTitle'
import { paneSessionEnv, preparePtyRuntimeLaunch } from '../../lib/agentRuntimeAdapter'
import { buildGhosttyCommand } from '../../lib/ghosttyCommand'
import { useT } from '../../lib/i18n'
import { shouldUseNativeBackend } from '../../lib/platform'
import { checkedResumePointer } from '../../lib/resumePointer'
import { sessionDisplayLabel } from '../../lib/sessionLabel'
import { buildAgentLaunch } from '../../lib/sessionLaunch'
import { getActiveSessions, savedConversationIdFor, saveSession } from '../../lib/sessionResume'
import {
  completeAgentHandoff,
  getPtyCwd,
  openInVscode,
  restartPty,
  snapshotCodexSessions,
  writeClipboardText,
} from '../../lib/tauri'
import {
  agentCliCommand,
  type AgentType,
  type SubTab,
  type Terminal as TerminalEntry,
  type Theme,
} from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { GhosttySurface } from '../GhosttySurface'
import { AgentIcon, VSCodeIcon } from '../icons/AgentIcons'
import { XTermView } from '../XTermView'
import styles from './TerminalPane.module.css'

export type TerminalPaneProps = {
  projectId: string
  terminal: TerminalEntry

  inFocusOverlay?: boolean

  preview?: boolean
}

export const TerminalPane = memo(function TerminalPane({
  projectId,
  terminal,
  inFocusOverlay = false,
  preview = false,
}: TerminalPaneProps) {
  const t = useT()
  const [resumeNonce, setResumeNonce] = useState(0)
  const [resumePending, setResumePending] = useState(false)
  const [refCopied, setRefCopied] = useState(false)
  const focusedTerminalId = useUiStore((s) => s.focusedTerminalId)
  const isFocusMode = inFocusOverlay || focusedTerminalId === terminal.id
  // The tab bar is what gets dragged now; the pane body only ever showed one
  // session, so there was nothing here to drop onto.
  const paneRef = useRef<HTMLDivElement | null>(null)
  const setRefs = (node: HTMLDivElement | null) => {
    paneRef.current = node
  }

  // A focus request from the sidebar: scroll the pane into view and focus xterm's input.
  const focusReq = useUiStore((s) => s.focusRequest)
  useEffect(() => {
    if (!focusReq || focusReq.terminalId !== terminal.id) return
    const node = paneRef.current
    if (!node) return
    node.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    const focusInput = () => {
      const textarea = node.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      textarea?.focus()
    }
    focusInput()
    const frame = window.requestAnimationFrame(focusInput)
    const shortRetry = window.setTimeout(focusInput, 120)
    const layoutRetry = window.setTimeout(focusInput, 420)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(shortRetry)
      window.clearTimeout(layoutRetry)
    }
  }, [focusReq, terminal.id])

  const setTerminalDisabled = useProjectsStore((s) => s.setTerminalDisabled)
  const markTerminalUsed = useProjectsStore((s) => s.markTerminalUsed)
  const setSubTabPtyId = useProjectsStore((s) => s.setSubTabPtyId)
  const setSubTabSessionId = useProjectsStore((s) => s.setSubTabSessionId)
  const setSubTabInitialInput = useProjectsStore((s) => s.setSubTabInitialInput)
  const setSubTabHandoff = useProjectsStore((s) => s.setSubTabHandoff)
  const setSubTabCompletionUnread = useProjectsStore((s) => s.setSubTabCompletionUnread)
  const clearTerminalCompletionUnread = useProjectsStore((s) => s.clearTerminalCompletionUnread)
  const deleteTerminalWithWorktreeCleanup = useProjectsStore(
    (s) => s.deleteTerminalWithWorktreeCleanup,
  )
  const openModal = useUiStore((s) => s.openModal_)
  const setFocusedTerminal = useUiStore((s) => s.setFocusedTerminal)
  const setActiveTerminal = useUiStore((s) => s.setActiveTerminal)
  const requestPaneFocus = useUiStore((s) => s.requestPaneFocus)
  const pushToast = useUiStore((s) => s.pushToast)
  const claudeUsage = useUiStore((s) => s.claudeUsage)
  const codexUsage = useUiStore((s) => s.codexUsage)
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )
  // Native Ghostty rendering is opt-in and macOS-only; other platforms use xterm.js.
  const nativeTerminalMacos = useProjectsStore((s) => s.preferences.nativeTerminalMacos ?? false)
  const useNativeBackend = shouldUseNativeBackend(nativeTerminalMacos)

  // The repo to wire the Graphify MCP into; XTermView resolves the config and bootstrap.
  const graphifyRepo = useProjectsStore((s) => {
    const p = s.projects.find((p) => p.id === projectId)
    if (!p?.graphifyEnabled) return null
    return terminal.cwd || p.terminals[0]?.cwd || null
  })

  // XTermView only acts on this for OpenCode (its trigger checks command === 'opencode').
  const gsdWatcherEnabled = useProjectsStore((s) => {
    const p = s.projects.find((p) => p.id === projectId)
    return Boolean(p?.gsdWatcherEnabled)
  })

  const activeTab: SubTab | undefined = useMemo(
    () => terminal.tabs.find((tab) => tab.id === terminal.activeTabId) ?? terminal.tabs[0],
    [terminal.tabs, terminal.activeTabId],
  )
  const runtimeExtraArgs = useMemo(() => {
    const args = [...(activeTab?.extraArgs ?? [])]
    if (activeTab?.handoff) args.push('--add-dir', activeTab.handoff.contextDir)
    return args
  }, [activeTab?.extraArgs, activeTab?.handoff])

  // Keyed by the two fields the env is built from rather than by the pane
  // object, which gets a new reference on every I/O tick.
  const paneId = terminal.id
  const paneShortId = terminal.shortId
  const paneEnv = useMemo(
    () => paneSessionEnv({ id: paneId, shortId: paneShortId }),
    [paneId, paneShortId],
  )

  // Selecting the runtime object would rerender the whole pane every time its
  // I/O timestamp moves — four times a second while an agent streams.
  const ptyExited = useTerminalsStore((s) => {
    const runtime = activeTab?.ptyId ? s.byPtyId[activeTab.ptyId] : undefined
    return runtime !== undefined && !runtime.alive
  })
  const ptyParked = useTerminalsStore((s) =>
    activeTab?.ptyId ? s.byPtyId[activeTab.ptyId]?.parked === true : false,
  )
  const canHandoff = activeTab?.type === 'claude' || activeTab?.type === 'codex'
  const handoffSuggested =
    (activeTab?.type === 'claude' && (claudeUsage?.five_hour.utilization ?? 0) >= 100) ||
    (activeTab?.type === 'codex' && codexUsage?.rate_limited === true)

  const copyPaneRef = async () => {
    if (!paneShortId) return
    try {
      await writeClipboardText(paneShortId)
      setRefCopied(true)
      pushToast({ title: t('ui.terminal.refCopied'), body: paneShortId })
      window.setTimeout(() => setRefCopied(false), 1500)
    } catch {
      setRefCopied(false)
    }
  }

  const openVscode = async () => {
    let target = cwd
    if (!target && activeTab?.ptyId) {
      target = (await getPtyCwd(activeTab.ptyId).catch(() => null)) ?? ''
    }
    if (!target) return
    await openInVscode(target).catch((err) => {
      console.error('opening VS Code failed', err)
    })
  }

  const onRestart = async () => {
    if (!activeTab?.ptyId || terminal.disabled) return
    if (ptyParked) {
      if (resumePending) return
      setResumePending(true)
      setResumeNonce((value) => value + 1)
      requestPaneFocus(terminal.id)
      return
    }
    const ptyId = activeTab.ptyId
    let restartCwd = (activeTab.cwd || terminal.cwd || '').trim()
    if (!restartCwd) {
      restartCwd = ((await getPtyCwd(ptyId).catch(() => null)) ?? '').trim()
    }
    const activeSessions = getActiveSessions()
    const savedSession = activeSessions[activeTab.id] ?? activeSessions[ptyId] ?? null
    let resumeSessionId =
      activeTab.sessionId ?? savedConversationIdFor(savedSession, activeTab.type, restartCwd)

    if (!resumeSessionId && activeTab.type === 'codex' && restartCwd) {
      resumeSessionId = (await snapshotCodexSessions(restartCwd).catch(() => []))[0]?.id
    }
    if (resumeSessionId && restartCwd) {
      resumeSessionId = await checkedResumePointer(
        activeTab.type,
        restartCwd,
        resumeSessionId,
        activeTab.id,
      )
    }
    const preparedRuntime = preparePtyRuntimeLaunch(
      activeTab.type,
      activeTab.runtimeProfile,
      activeTab.extraArgs ?? [],
      paneSessionEnv(terminal),
    )
    const launch = buildAgentLaunch(activeTab.type, preparedRuntime.args, resumeSessionId)
    if (launch.sessionId && launch.sessionId !== activeTab.sessionId) {
      setSubTabSessionId(projectId, terminal.id, activeTab.id, launch.sessionId)
    }

    useTerminalsStore.getState().beginRestart(ptyId)
    try {
      await restartPty({
        id: ptyId,
        cols: 80,
        rows: 24,
        command: agentCliCommand(activeTab.type),
        cwd: restartCwd || undefined,
        extraArgs: launch.args,
        env: preparedRuntime.env,
      })
      if (launch.sessionId) {
        saveSession(activeTab.id, {
          sessionId: ptyId,
          claudeSessionId: activeTab.type === 'claude' ? launch.sessionId : undefined,
          codexSessionId: activeTab.type === 'codex' ? launch.sessionId : undefined,
          antigravitySessionId: activeTab.type === 'antigravity' ? launch.sessionId : undefined,
          cwd: restartCwd,
          agent: activeTab.type,
          timestamp: Date.now(),
        })
      }
      window.dispatchEvent(new CustomEvent('arco:terminal-resize-request', { detail: { ptyId } }))
      requestPaneFocus(terminal.id)
      window.setTimeout(() => requestPaneFocus(terminal.id), 160)
    } catch (err) {
      console.error('restarting the PTY failed', err)
      pushToast({ title: t('ui.terminal.restartFailed'), body: String(err) })
    }
  }

  useEffect(() => {
    const onRestartRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId?: string; ptyId?: string }>).detail
      const matchesTerminal = detail?.terminalId === terminal.id
      const matchesPty = Boolean(detail?.ptyId && detail.ptyId === activeTab?.ptyId)
      if (matchesTerminal || matchesPty) void onRestart()
    }
    window.addEventListener('arco:terminal-restart-request', onRestartRequest)
    return () => window.removeEventListener('arco:terminal-restart-request', onRestartRequest)
  })

  const onDisable = () => setTerminalDisabled(projectId, terminal.id, !terminal.disabled)

  const onDelete = () => {
    if (!window.confirm(t('ui.sidebar.confirmDeleteTerminal', { name: terminal.name }))) return
    const handoffIds = terminal.tabs.flatMap((tab) => (tab.handoff ? [tab.handoff.id] : []))
    void Promise.allSettled(handoffIds.map((id) => completeAgentHandoff(id))).then(() =>
      deleteTerminalWithWorktreeCleanup(projectId, terminal.id),
    )
    if (isFocusMode) setFocusedTerminal(null)
  }

  const cwd = activeTab?.cwd?.trim() || terminal.cwd?.trim() || ''

  return (
    <div
      ref={setRefs}
      data-pane-box="1"
      onPointerDown={() => {
        markTerminalUsed(projectId, terminal.id)
        setActiveTerminal(projectId, terminal.id)
        // Reaching the pane at all is what "you have seen it" means. The row in
        // the sidebar lights up for any tab, and only a handful of the paths
        // that focus a pane used to clear anything — the keyboard, Find/Jump, a
        // task jumping to its session and the home view cleared nothing at all.
        clearTerminalCompletionUnread(projectId, terminal.id)
      }}
      className={`${styles.pane} ${isFocusMode ? styles.paneFocus : ''} ${terminal.disabled ? styles.disabled : ''}`}
    >
      <header className={styles.header}>
        <div
          className={styles.headLeft}
          onDoubleClick={() => setFocusedTerminal(isFocusMode ? null : terminal.id)}
          title={
            isFocusMode ? t('ui.terminal.exitFocusModeEsc') : t('ui.terminal.focusModeFullscreen')
          }
        >
          {paneShortId ? (
            <button
              type="button"
              className={`${styles.refPill} ${refCopied ? styles.refPillCopied : ''}`}
              onClick={(event) => {
                // The header's double-click toggles focus mode, and the pane's
                // own click handlers pull focus into the terminal.
                event.stopPropagation()
                void copyPaneRef()
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              title={
                refCopied
                  ? t('ui.terminal.refCopied')
                  : t('ui.terminal.copyRef', { ref: paneShortId })
              }
              aria-label={t('ui.terminal.copyRef', { ref: paneShortId })}
            >
              {refCopied ? <Check size={11} /> : null}
              {paneShortId}
            </button>
          ) : null}
          {activeTab ? (
            <>
              <span className={styles.iconWrap}>
                <AgentIcon type={activeTab.type} size={14} theme={terminalTheme} />
              </span>
              <PaneTitle
                paneId={paneId}
                name={terminal.name}
                nameSource={terminal.nameSource}
                tab={activeTab}
              />
            </>
          ) : null}
        </div>

        {!preview ? (
          <div className={styles.headRight}>
            <div className={styles.actions}>
              {activeTab && activeTab.type !== 'shell' ? (
                <button
                  type="button"
                  className={`${styles.action} ${styles.actionSecondary}`}
                  onClick={() =>
                    openModal('recentChats', {
                      projectId,
                      terminalId: terminal.id,
                      agent: activeTab.type,
                    })
                  }
                  title={t('ui.terminal.recentChats')}
                  aria-label={t('ui.terminal.recentChats')}
                >
                  <Clock size={12} />
                </button>
              ) : null}
              {canHandoff ? (
                <button
                  type="button"
                  className={`${styles.action} ${styles.actionSecondary} ${handoffSuggested ? styles.handoffSuggested : ''}`}
                  onClick={() =>
                    openModal('handoff', {
                      projectId,
                      terminalId: terminal.id,
                      agent: activeTab?.type,
                      sourceSessionId: activeTab?.sessionId,
                    })
                  }
                  title={
                    handoffSuggested ? t('ui.terminal.handoffSuggested') : t('ui.terminal.handoff')
                  }
                  aria-label={t('ui.terminal.handoff')}
                >
                  <ArrowRightLeft size={12} />
                </button>
              ) : null}
              <button
                type="button"
                className={`${styles.action} ${styles.actionSecondary}`}
                onClick={() => void openVscode()}
                title={t('ui.terminal.openInVscode')}
                aria-label={t('ui.terminal.openInVscode')}
                disabled={!activeTab}
              >
                <VSCodeIcon size={12} />
              </button>
              <button
                type="button"
                className={styles.action}
                onClick={() => setFocusedTerminal(isFocusMode ? null : terminal.id)}
                title={
                  isFocusMode
                    ? t('ui.terminal.exitFocusModeEsc')
                    : t('ui.terminal.focusModeFullscreen')
                }
                aria-label={
                  isFocusMode ? t('ui.terminal.exitFocusMode') : t('ui.terminal.focusMode')
                }
              >
                {isFocusMode ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
              {activeTab?.ptyId ? (
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => void onRestart()}
                  title={ptyParked ? t('ui.terminal.resume') : t('ui.terminal.restart')}
                  aria-label={ptyParked ? t('ui.terminal.resume') : t('ui.terminal.restart')}
                  disabled={terminal.disabled}
                >
                  <RefreshCw size={12} />
                </button>
              ) : null}
              {terminal.pinned ? (
                // An inert marker in the slot the delete used to hold, so the
                // row of actions does not reflow between an orchestrator and
                // its neighbours.
                <span
                  className={styles.action}
                  title={t('ui.group.orchestrator')}
                  aria-label={t('ui.group.orchestrator')}
                >
                  <Pin size={12} />
                </span>
              ) : (
                <button
                  type="button"
                  className={`${styles.action} ${styles.danger}`}
                  onClick={onDelete}
                  title={t('ui.sidebar.deleteTerminal')}
                  aria-label={t('ui.sidebar.deleteTerminal')}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          </div>
        ) : null}
      </header>

      <div className={styles.body}>
        <div className={styles.terminalArea}>
          {terminal.disabled ? (
            <DisabledOverlay
              terminalName={terminal.name}
              cwd={cwd}
              agentType={activeTab?.type ?? 'shell'}
              terminalTheme={terminalTheme}
              onReactivate={onDisable}
            />
          ) : activeTab ? (
            <>
              {useNativeBackend && !activeTab.handoff ? (
                <GhosttySurface
                  key={`${activeTab.id}:${resumeNonce}`}
                  surfaceId={activeTab.id}
                  cwd={activeTab.cwd?.trim() || terminal.cwd?.trim() || undefined}
                  command={buildGhosttyCommand(activeTab.type, activeTab.extraArgs)}
                  onSpawned={(id) => {
                    setResumePending(false)
                    if (activeTab.ptyId !== id) {
                      setSubTabPtyId(projectId, terminal.id, activeTab.id, id)
                    }
                  }}
                />
              ) : (
                <XTermView
                  key={`${activeTab.id}:${resumeNonce}`}
                  projectId={projectId}
                  ptyId={activeTab.ptyId ?? activeTab.id}
                  sessionKey={activeTab.id}
                  command={activeTab.type === 'shell' ? null : activeTab.type}
                  cwd={activeTab.cwd || null}
                  extraArgs={runtimeExtraArgs}
                  env={paneEnv}
                  initialInput={activeTab.initialInput}
                  runtimeProfile={activeTab.runtimeProfile}
                  sessionId={activeTab.sessionId}
                  graphifyRepo={graphifyRepo}
                  gsdWatcherEnabled={gsdWatcherEnabled}
                  trustSessionId={terminal.gsdSyncViewer}
                  readOnly={terminal.gsdSyncViewer}
                  terminalTheme={terminalTheme}
                  onSpawned={(id) => {
                    setResumePending(false)
                    if (activeTab.ptyId !== id) {
                      setSubTabPtyId(projectId, terminal.id, activeTab.id, id)
                    }
                  }}
                  onSessionId={(sessionId) => {
                    if (activeTab.sessionId !== sessionId) {
                      setSubTabSessionId(projectId, terminal.id, activeTab.id, sessionId)
                    }
                  }}
                  onInitialInputSent={() =>
                    setSubTabInitialInput(projectId, terminal.id, activeTab.id, undefined)
                  }
                  onLaunchError={(error) => {
                    if (!resumePending || !activeTab.ptyId) return
                    setResumePending(false)
                    useTerminalsStore.getState().markSuspended(activeTab.ptyId)
                    pushToast({ title: t('ui.terminal.resumeFailed'), body: String(error) })
                  }}
                  onAgentComplete={() => {
                    setSubTabCompletionUnread(projectId, terminal.id, activeTab.id, true)
                    if (!activeTab.handoff) return
                    void completeAgentHandoff(activeTab.handoff.id)
                      .then(() => setSubTabHandoff(projectId, terminal.id, activeTab.id, undefined))
                      .catch((cause) =>
                        console.warn('[handoff] could not clean the completed packet:', cause),
                      )
                  }}
                />
              )}
              {ptyExited && !useNativeBackend ? (
                <div className={styles.exitedOverlay}>
                  <RefreshCw size={24} style={{ opacity: 0.5 }} />
                  {!ptyParked ? (
                    <span className={styles.exitedLabel}>{t('ui.terminal.processEnded')}</span>
                  ) : null}
                  <button
                    type="button"
                    className={styles.restartBtn}
                    onClick={() => void onRestart()}
                    disabled={resumePending}
                    aria-busy={resumePending}
                  >
                    {resumePending
                      ? t('ui.terminal.resuming')
                      : ptyParked
                        ? t('ui.terminal.resume')
                        : t('ui.terminal.restart')}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <div className={styles.empty}>
              <X size={20} />
              <span>{t('ui.terminal.noTab')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

/**
 * The pane's title, resolved by the same rule the sidebar and the tab bar use:
 * a name someone gave the session, then the task it is for, then the title the
 * agent gave the conversation, and only last the agent's own label.
 *
 * Its own component because the conversation title loads on its own schedule;
 * when it lands, this label repaints and the pane around the terminal does not.
 */
const PaneTitle = memo(function PaneTitle({
  paneId,
  name,
  nameSource,
  tab,
}: {
  paneId: string
  name: string
  nameSource: TerminalEntry['nameSource']
  tab: SubTab
}) {
  const chatTitle = useSidebarChatTitle(tab)
  const taskTitle = usePaneTaskTitle(paneId)
  const label =
    sessionDisplayLabel({ name, nameSource, tabs: [tab] }, chatTitle, taskTitle) || tab.name
  return (
    <span className={styles.name} title={label}>
      {label}
    </span>
  )
})

function DisabledOverlay({
  terminalName,
  cwd,
  agentType,
  terminalTheme,
  onReactivate,
}: {
  terminalName: string
  cwd: string
  agentType: AgentType
  terminalTheme: Theme
  onReactivate: () => void
}) {
  const t = useT()
  return (
    <div className={styles.disabledOverlay}>
      <div className={styles.disabledIcon}>
        <AgentIcon type={agentType} size={56} theme={terminalTheme} />
      </div>
      <div className={styles.disabledName}>{terminalName}</div>
      {cwd ? <div className={styles.disabledCwd}>{cwd}</div> : null}
      <button type="button" className={styles.reactivateBtn} onClick={onReactivate}>
        {t('ui.sidebar.reactivate')}
      </button>
    </div>
  )
}

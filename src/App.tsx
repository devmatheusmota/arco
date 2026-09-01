import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Bell, X } from 'lucide-react'
import { type CSSProperties, lazy, Suspense, useEffect, useRef } from 'react'
import { Group as PanelGroup, Panel, Separator, usePanelRef } from 'react-resizable-panels'

import styles from './App.module.css'
import homeBackground from './assets/home-bg-right.png'
import { AgentSandbox } from './components/AgentSandbox'
import { DictationButton } from './components/DictationButton'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FocusOverlay } from './components/FocusOverlay'
import { AgentIcon } from './components/icons/AgentIcons'
import { LinkViewerOverlay } from './components/LinkViewerOverlay'
import { MainMenu } from './components/MainMenu'
import { AddBrowserModal } from './components/modals/AddBrowserModal'
import { AddContentModal } from './components/modals/AddContentModal'
import { AiUsageModal } from './components/modals/AiUsageModal'
import { EditProjectModal } from './components/modals/EditProjectModal'
import { FindJumpModal } from './components/modals/FindJumpModal'
import { HandoffModal } from './components/modals/HandoffModal'
import { McpIntroModal } from './components/modals/McpIntroModal'
import { McpManagerModal } from './components/modals/McpManagerModal'
import { NewProjectModal } from './components/modals/NewProjectModal'
import { NewSubTabModal } from './components/modals/NewSubTabModal'
import { NewTerminalModal } from './components/modals/NewTerminalModal'
import { OnboardingModal } from './components/modals/OnboardingModal'
import { PreferencesModal } from './components/modals/PreferencesModal'
import { ProfilesModal } from './components/modals/ProfilesModal'
import { RecentChatsModal } from './components/modals/RecentChatsModal'
import { RemoteControlModal } from './components/modals/RemoteControlModal'
import { SyncModal } from './components/modals/SyncModal'
import { TaskSessionModal } from './components/modals/TaskSessionModal'
import { ThemePickerModal } from './components/modals/ThemePickerModal'
import { TodoSettingsModal } from './components/modals/TodoSettingsModal'
import { TopbarSettingsModal } from './components/modals/TopbarSettingsModal'
import { UpdateModal } from './components/modals/UpdateModal'
import { WelcomeModal } from './components/modals/WelcomeModal'
import { WhatsNewModal } from './components/modals/WhatsNewModal'
import { ProjectSidebar } from './components/ProjectSidebar'
import { RightSidebar } from './components/RightSidebar'
import { TitleBar } from './components/TitleBar'
import { TokenHud } from './components/TokenHud'
import { AsciiEffect } from './components/ui/ascii-effect'
import { WorkspaceView } from './components/WorkspaceView'
import { useAdoRefRepair } from './hooks/useAdoRefRepair'
import { useCliOpenRequests } from './hooks/useCliOpenRequests'
import { useCloseConfirmation } from './hooks/useCloseConfirmation'
import { useKeybindings } from './hooks/useKeybindings'
import { useMcpIntroPrompt } from './hooks/useMcpIntroPrompt'
import { useRemoteControlService } from './hooks/useRemoteControlService'
import { useResourceSupervisor } from './hooks/useResourceSupervisor'
import { rendersWorkspace } from './lib/activeView'
import { startActivityTracker } from './lib/activityTracker'
import { APP_SHELL_ID } from './lib/appShell'
import { startCliBridge } from './lib/cliBridge'
import { intlLocale, translate, useT } from './lib/i18n'
import { visibilityFromPanelResize, widthFromPanelResize } from './lib/sidebarPanelState'
import { setMaxConcurrentSpawns } from './lib/spawnQueue'
import { ghosttyKillAll, setWindowOpacity } from './lib/tauri'
import { getLastCrashReport } from './lib/tauri'
import { loadThemeIconBytes } from './lib/themeIcons'
import { checkForUpdate } from './lib/updater'
import { useProjectsStore } from './stores/projectsStore'
import { type InAppToast, useUiStore } from './stores/uiStore'

const AgentCanvasPOC = lazy(() =>
  import('./components/AgentCanvasPOC').then((module) => ({ default: module.AgentCanvasPOC })),
)
const BoardView = lazy(() =>
  import('./components/BoardView').then((module) => ({ default: module.BoardView })),
)
const HomeView = lazy(() =>
  import('./components/HomeView').then((module) => ({ default: module.HomeView })),
)
const MemoryAnalyticsModal = lazy(() =>
  import('./components/modals/MemoryAnalyticsModal').then((module) => ({
    default: module.MemoryAnalyticsModal,
  })),
)

function LoadingScreen() {
  const t = useT()
  return (
    <div className={styles.loadingScreen} role="status" aria-label={t('loading.initializing')}>
      <div className={styles.loadingBackdrop} aria-hidden="true">
        <AsciiEffect
          imageSrc={homeBackground}
          alt=""
          variant="flow"
          fontSize={8}
          brightnessBoost={2.25}
          contrast={1.15}
          threshold={0.02}
          flowSpeed={0.16}
          flowStrength={9}
          mouseRadius={260}
          mouseStrength={16}
          scale={1}
          fit="cover"
          colors={['var(--fg-muted)', 'var(--fg)']}
          backgroundColor="transparent"
        />
      </div>
      <div className={styles.loadingInner}>
        <div className={styles.loadingWordmark}>Arco</div>
        <div className={styles.loadingConsole}>
          <span className={styles.loadingPrompt} aria-hidden="true">
            ›
          </span>
          <span>{t('loading.initializing')}</span>
          <span className={styles.loadingCursor} aria-hidden="true" />
        </div>
        <div className={styles.loadingRail} aria-hidden="true">
          {Array.from({ length: 12 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
      </div>
    </div>
  )
}

function ToastItem({ toast }: { toast: InAppToast }) {
  const dismissToast = useUiStore((s) => s.dismissToast)
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)

  // An actionable toast asks something of the reader, so it holds long enough to
  // be read and answered instead of vanishing at the usual banner pace.
  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(toast.id), toast.action ? 20_000 : 6500)
    return () => window.clearTimeout(timer)
  }, [dismissToast, toast.action, toast.id])

  const accentStyle = {
    '--toast-accent': toast.agent ? `var(--agent-${toast.agent})` : 'var(--accent)',
  } as CSSProperties

  return (
    <div className={styles.toast} role="status" style={accentStyle}>
      <div className={styles.toastIcon} aria-hidden>
        {toast.agent ? (
          <AgentIcon type={toast.agent} size={16} theme={uiTheme} />
        ) : (
          <Bell size={14} />
        )}
      </div>
      <div className={styles.toastText}>
        <strong>{toast.title}</strong>
        <span title={toast.body}>{toast.body}</span>
        {toast.action ? (
          <button
            type="button"
            className={styles.toastAction}
            onClick={() => {
              toast.action?.run()
              dismissToast(toast.id)
            }}
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className={styles.toastClose}
        onClick={() => dismissToast(toast.id)}
        aria-label="Close notification"
        title="Close"
      >
        <X size={14} />
      </button>
    </div>
  )
}

function InAppNotifications() {
  const toasts = useUiStore((s) => s.toasts)
  if (toasts.length === 0) return null

  return (
    <div className={styles.toastStack} aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}

export default function App() {
  const hydrate = useProjectsStore((s) => s.hydrate)
  const hydrated = useProjectsStore((s) => s.hydrated)
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)
  const visualStyle = useProjectsStore((s) => s.preferences.visualStyle ?? 'normal')
  const appIconTheme = useProjectsStore((s) => s.preferences.appIconTheme)
  const uiZoom = useProjectsStore((s) => s.preferences.uiZoom)
  const windowOpacity = useProjectsStore((s) => s.preferences.windowOpacity)
  const language = useProjectsStore((s) => s.preferences.language)
  const spawnConcurrency = useProjectsStore((s) => s.preferences.spawnConcurrency)
  const activeView = useUiStore((s) => s.activeView)
  const openModal = useUiStore((s) => s.openModal)
  const restoreMarkdownSidebarHistory = useUiStore((s) => s.restoreMarkdownSidebarHistory)
  const activeProfileId = useProjectsStore((s) => s.activeProfileId)
  const leftSidebarVisible = useProjectsStore((s) => s.preferences.leftSidebarVisible)
  const rightSidebarVisible = useProjectsStore((s) => s.preferences.rightSidebarVisible)
  const leftSidebarWidth = useProjectsStore((s) => s.preferences.leftSidebarWidth)
  const rightSidebarWidth = useProjectsStore((s) => s.preferences.rightSidebarWidth)
  const todosEnabled = useProjectsStore((s) => s.preferences.enabledFeatures.todos)
  const gitEnabled = useProjectsStore((s) => s.preferences.enabledFeatures.git)
  const mcpEnabled = useProjectsStore((s) => s.preferences.enabledFeatures.mcp)
  const gitControlPlacement = useProjectsStore((s) => s.preferences.gitControlPlacement)
  const rightPanelEnabled =
    todosEnabled || mcpEnabled || (gitEnabled && gitControlPlacement === 'right')
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  // Keep panel defaults stable while dragging. Updating defaultSize on every
  // resize event can make react-resizable-panels rebuild the layout mid-drag.
  const leftSidebarDefaultRef = useRef(leftSidebarWidth)
  const rightSidebarDefaultRef = useRef(rightSidebarWidth)
  const sidebarDefaultsHydratedRef = useRef(false)
  const leftPanelRef = usePanelRef()
  const rightPanelRef = usePanelRef()
  const leftSidebarSaveTimerRef = useRef<number | null>(null)
  const rightSidebarSaveTimerRef = useRef<number | null>(null)
  const leftSidebarLayoutReadyRef = useRef(false)
  const rightSidebarLayoutReadyRef = useRef(false)
  const leftSidebarResizeActiveRef = useRef(false)
  const rightSidebarResizeActiveRef = useRef(false)
  const leftPanelElementRef = useRef<HTMLDivElement>(null)
  const rightPanelElementRef = useRef<HTMLDivElement>(null)

  // Hydration completes before the panels mount. Capture the persisted widths
  // on that render so their first layout does not fall back to store defaults.
  if (hydrated && !sidebarDefaultsHydratedRef.current) {
    leftSidebarDefaultRef.current = leftSidebarWidth
    rightSidebarDefaultRef.current = rightSidebarWidth
    sidebarDefaultsHydratedRef.current = true
  }

  useKeybindings()
  useMcpIntroPrompt()
  useRemoteControlService()
  useCloseConfirmation()
  useResourceSupervisor(hydrated)
  useCliOpenRequests(hydrated)
  useAdoRefRepair(hydrated)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // The CLI talks to the local listener, which emits events the store has to act
  // on. Mounted once, after hydrate, so a request never lands on an empty store.
  useEffect(() => {
    if (!hydrated) return
    let dispose: (() => void) | undefined
    let cancelled = false
    void startCliBridge()
      .then((unlisten) => {
        if (cancelled) unlisten()
        else dispose = unlisten
      })
      .catch((error) => console.warn('[cli] bridge failed to start:', error))
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [hydrated])

  useEffect(() => {
    if (hydrated) restoreMarkdownSidebarHistory()
  }, [activeProfileId, hydrated, restoreMarkdownSidebarHistory])

  useEffect(() => {
    void ghosttyKillAll().catch(() => {
      /* No-op on unsupported platforms. */
    })
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const first = !root.dataset.theme
    root.dataset.theme = uiTheme
    // The fade between themes used to come from a transition on every element in
    // the tree. It is worth having, but only while the theme is actually
    // changing — and never on the first paint, which would fade the app in.
    if (first) return
    root.classList.add('themeSwitching')
    const timer = window.setTimeout(() => root.classList.remove('themeSwitching'), 220)
    return () => {
      window.clearTimeout(timer)
      root.classList.remove('themeSwitching')
    }
  }, [uiTheme])

  useEffect(() => {
    document.documentElement.dataset.visualStyle = visualStyle
  }, [visualStyle])

  useEffect(() => {
    if (!hydrated) return
    void loadThemeIconBytes(appIconTheme)
      .then((bytes) => getCurrentWindow().setIcon(bytes))
      .catch((error) => {
        console.error('[app-icon] failed to apply window icon', error)
      })
  }, [appIconTheme, hydrated])

  useEffect(() => {
    document.documentElement.lang = language === 'pt-BR' ? 'pt-BR' : 'en'
  }, [language])

  useEffect(() => {
    setMaxConcurrentSpawns(spawnConcurrency)
  }, [spawnConcurrency])

  useEffect(() => {
    if (!hydrated) return
    document.documentElement.dataset.zoom = String(uiZoom)
    void getCurrentWebview()
      .setZoom(uiZoom)
      .catch(() => {
        /* Browser tests may not expose the Tauri permission. */
      })
      .finally(() => {
        window.dispatchEvent(new CustomEvent('arco:zoom-changed', { detail: { zoom: uiZoom } }))
      })
  }, [hydrated, uiZoom])

  useEffect(() => {
    if (!hydrated) return
    void setWindowOpacity(windowOpacity).catch(() => {
      /* Keep the window opaque where native opacity is unavailable. */
    })
  }, [hydrated, windowOpacity])

  useEffect(() => {
    if (!hydrated) return
    leftSidebarLayoutReadyRef.current = false
    const element = leftPanelElementRef.current
    if (element) element.style.transition = 'flex-grow 180ms ease, flex-basis 180ms ease'
    const frame = window.requestAnimationFrame(() => {
      if (leftSidebarVisible) leftPanelRef.current?.expand()
      else leftPanelRef.current?.collapse()
    })
    const timer = window.setTimeout(() => {
      if (element) element.style.transition = ''
      leftSidebarLayoutReadyRef.current = true
    }, 220)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      if (element) element.style.transition = ''
    }
  }, [hydrated, leftPanelRef, leftSidebarVisible])

  useEffect(() => {
    if (!hydrated) return
    rightSidebarLayoutReadyRef.current = false
    const element = rightPanelElementRef.current
    if (element) element.style.transition = 'flex-grow 180ms ease, flex-basis 180ms ease'
    const frame = window.requestAnimationFrame(() => {
      if (rightPanelEnabled && rightSidebarVisible) rightPanelRef.current?.expand()
      else rightPanelRef.current?.collapse()
    })
    const timer = window.setTimeout(() => {
      if (element) element.style.transition = ''
      rightSidebarLayoutReadyRef.current = true
    }, 220)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      if (element) element.style.transition = ''
    }
  }, [hydrated, rightPanelRef, rightSidebarVisible, rightPanelEnabled])

  useEffect(() => {
    if (!hydrated) return
    const { preferences, setPreferences } = useProjectsStore.getState()
    if (preferences.firstLaunchAt === null) {
      setPreferences({ firstLaunchAt: Date.now() })
    }
    // A tela de boas-vindas não abre sozinha; segue disponível no menu.
    useUiStore.getState().setActiveView(preferences.alwaysStartOnHome ? 'home' : 'workspace')
  }, [hydrated])

  useEffect(() => {
    if (!hydrated) return
    return startActivityTracker()
  }, [hydrated])

  useEffect(
    () => () => {
      if (leftSidebarSaveTimerRef.current !== null)
        window.clearTimeout(leftSidebarSaveTimerRef.current)
      if (rightSidebarSaveTimerRef.current !== null)
        window.clearTimeout(rightSidebarSaveTimerRef.current)
    },
    [],
  )

  useEffect(() => {
    if (!hydrated) return
    let cancelled = false
    void checkForUpdate()
      .then((info) => {
        if (!cancelled) useUiStore.getState().setUpdateInfo(info)
      })
      .catch((error) => {
        console.error('[update] checagem de fundo falhou:', error)
      })
    return () => {
      cancelled = true
    }
  }, [hydrated])

  useEffect(() => {
    if (!hydrated) return
    void getLastCrashReport()
      .then((report) => {
        if (!report) return
        const { session, orphans_reaped: orphansReaped } = report
        const lang = useProjectsStore.getState().preferences.language
        const when = new Date(session.last_heartbeat_ms || session.started_at_ms)
        const bodyKey = orphansReaped > 0 ? 'crash.uncleanBodyWithOrphans' : 'crash.uncleanBody'
        useUiStore.getState().pushToast({
          title: translate(lang, 'crash.uncleanTitle'),
          body: translate(lang, bodyKey, {
            total: Math.round(session.total_mb),
            procs: session.process_count,
            time: when.toLocaleTimeString(intlLocale(lang)),
            orphans: orphansReaped,
          }),
        })
      })
      .catch(() => {})
  }, [hydrated])

  if (!hydrated) {
    return <LoadingScreen />
  }

  return (
    <>
      <div className={styles.appShell} id={APP_SHELL_ID} tabIndex={-1}>
        <TitleBar />
        <PanelGroup
          orientation="horizontal"
          className={styles.shellBody}
          resizeTargetMinimumSize={{ coarse: 28, fine: 18 }}
        >
          <Panel
            id="arco-left-sidebar"
            panelRef={leftPanelRef}
            elementRef={leftPanelElementRef}
            defaultSize={leftSidebarVisible ? `${leftSidebarDefaultRef.current}px` : '0px'}
            minSize="220px"
            maxSize="380px"
            collapsedSize="0px"
            collapsible
            groupResizeBehavior="preserve-pixel-size"
            onResize={(size, _id, previous) => {
              const currentVisible = useProjectsStore.getState().preferences.leftSidebarVisible
              const nextVisible = visibilityFromPanelResize(
                leftSidebarLayoutReadyRef.current,
                leftSidebarResizeActiveRef.current,
                size,
                previous,
                currentVisible,
              )
              if (nextVisible !== null) setPreferences({ leftSidebarVisible: nextVisible })
              const nextWidth = widthFromPanelResize(
                leftSidebarLayoutReadyRef.current,
                leftSidebarResizeActiveRef.current,
                size,
                previous,
                220,
                380,
              )
              if (nextWidth !== null) {
                if (leftSidebarSaveTimerRef.current !== null)
                  window.clearTimeout(leftSidebarSaveTimerRef.current)
                leftSidebarSaveTimerRef.current = window.setTimeout(() => {
                  leftSidebarSaveTimerRef.current = null
                  leftSidebarDefaultRef.current = nextWidth
                  setPreferences({ leftSidebarWidth: nextWidth })
                }, 180)
              }
            }}
          >
            <div className={styles.sidebarContent} data-hidden={!leftSidebarVisible}>
              <ProjectSidebar />
            </div>
          </Panel>
          <Separator
            className={`${styles.shellSeparator} ${leftSidebarVisible ? '' : styles.shellSeparatorHidden}`}
            onPointerDown={() => {
              leftSidebarResizeActiveRef.current = true
            }}
            onPointerUp={() => {
              leftSidebarResizeActiveRef.current = false
            }}
            onPointerCancel={() => {
              leftSidebarResizeActiveRef.current = false
            }}
            onLostPointerCapture={() => {
              leftSidebarResizeActiveRef.current = false
            }}
            onKeyDown={() => {
              leftSidebarResizeActiveRef.current = true
            }}
            onKeyUp={() => {
              leftSidebarResizeActiveRef.current = false
            }}
            onBlur={() => {
              leftSidebarResizeActiveRef.current = false
            }}
          />

          <Panel id="arco-main" minSize="360px">
            <main className={styles.mainView}>
              <ErrorBoundary label="view">
                <Suspense fallback={<LoadingScreen />}>
                  {/* The workspace answers for anything the enum cannot render;
                      `rendersWorkspace` is the same rule the panes read. */}
                  {rendersWorkspace(activeView) ? (
                    <WorkspaceView />
                  ) : activeView === 'board' ? (
                    <BoardView />
                  ) : activeView === 'agentSandbox' ? (
                    <AgentSandbox />
                  ) : activeView === 'agentCanvas' ? (
                    <AgentCanvasPOC />
                  ) : (
                    <HomeView />
                  )}
                </Suspense>
              </ErrorBoundary>
            </main>
          </Panel>

          {rightPanelEnabled ? (
            <>
              <Separator
                className={`${styles.shellSeparator} ${rightSidebarVisible ? '' : styles.shellSeparatorHidden}`}
                onPointerDown={() => {
                  rightSidebarResizeActiveRef.current = true
                }}
                onPointerUp={() => {
                  rightSidebarResizeActiveRef.current = false
                }}
                onPointerCancel={() => {
                  rightSidebarResizeActiveRef.current = false
                }}
                onLostPointerCapture={() => {
                  rightSidebarResizeActiveRef.current = false
                }}
                onKeyDown={() => {
                  rightSidebarResizeActiveRef.current = true
                }}
                onKeyUp={() => {
                  rightSidebarResizeActiveRef.current = false
                }}
                onBlur={() => {
                  rightSidebarResizeActiveRef.current = false
                }}
              />
              <Panel
                id="arco-todo-sidebar"
                panelRef={rightPanelRef}
                elementRef={rightPanelElementRef}
                defaultSize={rightSidebarVisible ? `${rightSidebarDefaultRef.current}px` : '0px'}
                minSize="260px"
                maxSize="420px"
                collapsedSize="0px"
                collapsible
                groupResizeBehavior="preserve-pixel-size"
                onResize={(size, _id, previous) => {
                  const currentVisible = useProjectsStore.getState().preferences.rightSidebarVisible
                  const nextVisible = visibilityFromPanelResize(
                    rightSidebarLayoutReadyRef.current,
                    rightSidebarResizeActiveRef.current,
                    size,
                    previous,
                    currentVisible,
                  )
                  if (nextVisible !== null) setPreferences({ rightSidebarVisible: nextVisible })
                  const nextWidth = widthFromPanelResize(
                    rightSidebarLayoutReadyRef.current,
                    rightSidebarResizeActiveRef.current,
                    size,
                    previous,
                    260,
                    420,
                  )
                  if (nextWidth !== null) {
                    if (rightSidebarSaveTimerRef.current !== null)
                      window.clearTimeout(rightSidebarSaveTimerRef.current)
                    rightSidebarSaveTimerRef.current = window.setTimeout(() => {
                      rightSidebarSaveTimerRef.current = null
                      rightSidebarDefaultRef.current = nextWidth
                      setPreferences({ rightSidebarWidth: nextWidth })
                    }, 180)
                  }
                }}
              >
                <div className={styles.sidebarContent} data-hidden={!rightSidebarVisible}>
                  <RightSidebar />
                </div>
              </Panel>
            </>
          ) : null}
        </PanelGroup>
      </div>
      <FocusOverlay />
      <LinkViewerOverlay />
      <DictationButton />
      <MainMenu />
      <ErrorBoundary label="modals">
        <NewProjectModal />
        <EditProjectModal />
        <NewTerminalModal />
        <AddContentModal />
        <AddBrowserModal />
        <NewSubTabModal />
        <PreferencesModal />
        <ProfilesModal />
        <SyncModal />
        <FindJumpModal />
        <OnboardingModal />
        <WelcomeModal />
        {openModal === 'memoryAnalytics' ? (
          <Suspense fallback={null}>
            <MemoryAnalyticsModal />
          </Suspense>
        ) : null}
        <ThemePickerModal />
        <TodoSettingsModal />
        <TaskSessionModal />
        <TopbarSettingsModal />
        <AiUsageModal />
        <UpdateModal />
        <WhatsNewModal />
        <RecentChatsModal />
        <HandoffModal />
        <McpManagerModal />
        <McpIntroModal />
        <RemoteControlModal />
      </ErrorBoundary>
      <InAppNotifications />
      {activeView === 'agentCanvas' ? <TokenHud /> : null}
    </>
  )
}

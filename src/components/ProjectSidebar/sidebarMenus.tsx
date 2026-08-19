import {
  Archive,
  FileText,
  FolderOpen,
  Globe2,
  Layout,
  PanelTopOpen,
  Pencil,
  Plus,
  Power,
  Smartphone,
  SmartphoneNfc,
  Trash2,
} from 'lucide-react'

import { preparePtyRuntimeLaunch } from '../../lib/agentRuntimeAdapter'
import { useT } from '../../lib/i18n'
import { buildAgentLaunch } from '../../lib/sessionLaunch'
import { getPtyCwd, openInFileExplorer, openInVscode, restartPty } from '../../lib/tauri'
import { agentCliCommand, type Project, type Terminal } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { type MenuItem } from './ContextMenu'

type ProjectsState = ReturnType<typeof useProjectsStore.getState>
type UiState = ReturnType<typeof useUiStore.getState>

type MenuActions = Pick<
  ProjectsState,
  | 'openProjectWorkspace'
  | 'renameProject'
  | 'archiveProject'
  | 'setProjectDisabled'
  | 'deleteProject'
  | 'createGraphifyPane'
  | 'focusWorkspaceTerminal'
  | 'openTerminalWorkspace'
  | 'renameTerminal'
  | 'togglePane'
  | 'setTerminalDisabled'
  | 'killTerminal'
  | 'setTerminalRemoteExcluded'
  | 'deleteTerminal'
  | 'deleteTerminalWithWorktreeCleanup'
  | 'setPreferences'
>

export type SidebarMenuDeps = {
  t: ReturnType<typeof useT>
  graphifyEnabled: boolean
  browserEnabled: boolean
  openPaneSets: Record<string, Set<string>>
  actions: MenuActions
  openModal: UiState['openModal_']
  setActiveView: UiState['setActiveView']
  setActiveTerminal: UiState['setActiveTerminal']
  setFocusedTerminal: UiState['setFocusedTerminal']
  requestPaneFocus: UiState['requestPaneFocus']
  openMarkdownSidebar: UiState['openMarkdownSidebar']
}

function visibleProjectTerminals(project: Project): Terminal[] {
  return project.terminals.filter((term) => !term.gsdSyncViewer)
}

export function createSidebarMenus(deps: SidebarMenuDeps) {
  const {
    t,
    graphifyEnabled,
    browserEnabled,
      openPaneSets,
    actions,
    openModal,
    setActiveView,
    setActiveTerminal,
    setFocusedTerminal,
    requestPaneFocus,
    openMarkdownSidebar,
  } = deps

  const projectMenu = (project: Project): MenuItem[] => [
    {
      kind: 'item',
      label: t('ui.workspace.openInTab'),
      icon: <FolderOpen size={14} />,
      onClick: () => {
        actions.openProjectWorkspace(project.id)
        setActiveView('workspace')
      },
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: t('ui.sidebar.editNameColor'),
      icon: <Pencil size={14} />,
      onClick: () => openModal('editProject', { projectId: project.id }),
    },
    {
      kind: 'item',
      label: t('ui.sidebar.quickRename'),
      icon: <Pencil size={14} />,
      onClick: () => {
        const name = window.prompt(t('ui.sidebar.newNamePrompt'), project.name)?.trim()
        if (name) actions.renameProject(project.id, name)
      },
    },
    {
      kind: 'item',
      label: t('ui.sidebar.newTerminalHere'),
      icon: <Plus size={14} />,
      onClick: () => openModal('newTerminal', { projectId: project.id }),
    },
    ...(browserEnabled
      ? [
          {
            kind: 'item' as const,
            label: t('menu.addBrowser'),
            icon: <Globe2 size={14} />,
            onClick: () => openModal('addBrowser', { projectId: project.id }),
          },
        ]
      : []),
    ...(graphifyEnabled
      ? [
          {
            kind: 'item' as const,
            label: t('graphify.startInProject'),
            onClick: () => {
              const repoPath = project.terminals[0]?.cwd
              if (repoPath) {
                actions.createGraphifyPane(project.id, repoPath)
                setActiveView('workspace')
              } else {
                alert('Adicione um terminal ao projeto primeiro para obter a raiz do repositório.')
              }
            },
          },
        ]
      : []),
    {
      kind: 'item',
      label: t('ui.sidebar.archiveProject'),
      icon: <Archive size={14} />,
      onClick: () => actions.archiveProject(project.id),
    },
    {
      kind: 'item',
      label:
        visibleProjectTerminals(project).length > 0 &&
        visibleProjectTerminals(project).every((term) => term.disabled)
          ? t('ui.sidebar.reactivateProject')
          : t('ui.sidebar.disableProject'),
      icon: <Power size={14} />,
      onClick: () => {
        const terms = visibleProjectTerminals(project)
        const allDisabled = terms.length > 0 && terms.every((term) => term.disabled)
        actions.setProjectDisabled(project.id, !allDisabled)
      },
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: t('ui.sidebar.deleteProject'),
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => {
        if (
          window.confirm(
            t('ui.sidebar.confirmDeleteProject', {
              name: project.name,
              count: project.terminals.length,
            }),
          )
        ) {
          actions.deleteProject(project.id)
        }
      },
    },
  ]

  const activeTerminalTab = (term: Terminal) =>
    term.tabs.find((tab) => tab.id === term.activeTabId) ?? term.tabs[0]

  const resolveTerminalCwd = async (term: Terminal): Promise<string | null> => {
    const activeTab = activeTerminalTab(term)
    const saved = activeTab?.cwd?.trim() || term.cwd?.trim()
    if (saved) return saved
    if (!activeTab?.ptyId) return null
    return getPtyCwd(activeTab.ptyId).catch(() => null)
  }

  const openTerminalPath = async (
    term: Terminal,
    action: (path: string) => Promise<void>,
    label: string,
  ) => {
    const path = await resolveTerminalCwd(term)
    if (!path) {
      window.alert(t('ui.terminal.noCwdAvailable', { label }))
      return
    }
    try {
      await action(path)
    } catch (err) {
      window.alert(t('ui.terminal.openFailed', { label, error: String(err) }))
    }
  }

  const restartTerminal = async (term: Terminal) => {
    const activeTab = activeTerminalTab(term)
    if (!activeTab?.ptyId || term.disabled) return
    const runtime = preparePtyRuntimeLaunch(
      activeTab.type,
      activeTab.runtimeProfile,
      activeTab.extraArgs ?? [],
    )
    const launch = buildAgentLaunch(activeTab.type, runtime.args, activeTab.sessionId)
    useTerminalsStore.getState().beginRestart(activeTab.ptyId)
    try {
      await restartPty({
        id: activeTab.ptyId,
        cols: 80,
        rows: 24,
        command: agentCliCommand(activeTab.type),
        cwd: activeTab.cwd || undefined,
        extraArgs: launch.args,
        env: runtime.env,
      })
      window.dispatchEvent(
        new CustomEvent('arco:terminal-resize-request', { detail: { ptyId: activeTab.ptyId } }),
      )
    } catch (err) {
      window.alert(
        t('ui.terminal.openFailed', { label: t('ui.terminal.restart'), error: String(err) }),
      )
    }
  }

  const confirmAndDeleteTerminal = (projectId: string, term: Terminal) => {
    if (window.confirm(t('ui.sidebar.confirmDeleteTerminal', { name: term.name }))) {
      void actions.deleteTerminalWithWorktreeCleanup(projectId, term.id)
    }
  }

  const terminalMenu = (projectId: string, term: Terminal): MenuItem[] => {
    const inSplit = openPaneSets[projectId]?.has(term.id) ?? false
    const activeTab = activeTerminalTab(term)
    const isTerminalPane = !term.kind || term.kind === 'terminal'
    return [
      {
        kind: 'item',
        label: t('terminalInspector.reveal'),
        icon: <PanelTopOpen size={14} />,
        onClick: () => {
          setActiveTerminal(projectId, term.id)
          actions.focusWorkspaceTerminal(projectId, term.id)
          requestPaneFocus(term.id)
          setActiveView('workspace')
        },
      },
      ...(activeTab?.ptyId && isTerminalPane && !term.disabled
        ? [
            {
              kind: 'item' as const,
              label: t('ui.terminal.restart'),
              icon: <Power size={14} />,
              onClick: () => void restartTerminal(term),
            },
          ]
        : []),
      ...(isTerminalPane
        ? [
            {
              kind: 'item' as const,
              label: t('ui.terminal.openInExplorer'),
              icon: <FolderOpen size={14} />,
              onClick: () => void openTerminalPath(term, openInFileExplorer, 'Explorer'),
            },
            {
              kind: 'item' as const,
              label: t('ui.terminal.openInVscode'),
              icon: <FolderOpen size={14} />,
              onClick: () => void openTerminalPath(term, openInVscode, 'VS Code'),
            },
            {
              kind: 'item' as const,
              label: t('ui.terminal.focusMode'),
              icon: <PanelTopOpen size={14} />,
              onClick: () => {
                setActiveTerminal(projectId, term.id)
                actions.focusWorkspaceTerminal(projectId, term.id)
                setFocusedTerminal(term.id)
                setActiveView('workspace')
              },
            },
          ]
        : []),
      { kind: 'separator' },
      {
        kind: 'item',
        label: t('ui.workspace.openInTab'),
        onClick: () => {
          actions.openTerminalWorkspace(projectId, term.id)
          setActiveView('workspace')
        },
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: t('ui.sidebar.rename'),
        icon: <Pencil size={14} />,
        onClick: () => {
          const name = window.prompt(t('ui.sidebar.newNamePrompt'), term.name)?.trim()
          if (name) actions.renameTerminal(projectId, term.id, name)
        },
      },
      {
        kind: 'item',
        label: inSplit ? t('ui.sidebar.hideFromSplit') : t('ui.sidebar.showInSplit'),
        icon: <Layout size={14} />,
        onClick: () => actions.togglePane(projectId, term.id),
      },
      ...(term.kind === 'markdown' && term.filePath
        ? [
            {
              kind: 'item' as const,
              label: t('rightSidebar.openMarkdown'),
              icon: <FileText size={14} />,
              onClick: () => {
                openMarkdownSidebar(term.filePath!, term.name)
                actions.setPreferences({ rightSidebarVisible: true })
              },
            },
          ]
        : []),
      ...(isTerminalPane
        ? [
            {
              kind: 'item' as const,
              label: term.remoteExcluded
                ? t('ui.terminal.shareWithRemote')
                : t('ui.terminal.hideFromRemote'),
              icon: term.remoteExcluded ? <Smartphone size={14} /> : <SmartphoneNfc size={14} />,
              onClick: () =>
                actions.setTerminalRemoteExcluded(projectId, term.id, !term.remoteExcluded),
            },
          ]
        : []),
      {
        kind: 'item',
        label: term.disabled ? t('ui.sidebar.reactivate') : t('ui.sidebar.disable'),
        icon: <Power size={14} />,
        onClick: () => actions.setTerminalDisabled(projectId, term.id, !term.disabled),
      },
      {
        kind: 'item',
        label: t('ui.sidebar.killTerminal'),
        icon: <Power size={14} />,
        onClick: () => actions.killTerminal(projectId, term.id),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: t('ui.sidebar.deleteTerminal'),
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => confirmAndDeleteTerminal(projectId, term),
      },
    ]
  }

  return { projectMenu, terminalMenu }
}

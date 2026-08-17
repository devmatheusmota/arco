export function workspacePanelScreenId(
  activeTabId: string | null,
  activeProjectId: string | null,
): string {
  if (activeTabId) return `tab-${activeTabId}`
  if (activeProjectId) return `project-${activeProjectId}`
  return 'workspace'
}

export function panelLayoutStorageId(
  profileId: string,
  screenId: string,
  persistenceId: string,
): string {
  return `arco-panels:${profileId}:${screenId}:${persistenceId}`
}

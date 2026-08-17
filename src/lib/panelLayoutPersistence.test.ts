import { describe, expect, it } from 'vitest'

import { panelLayoutStorageId, workspacePanelScreenId } from './panelLayoutPersistence'

describe('workspace panel layout persistence', () => {
  it('scopes layouts to the active workspace screen', () => {
    expect(workspacePanelScreenId('tab-a', 'project-a')).toBe('tab-tab-a')
    expect(workspacePanelScreenId(null, 'project-a')).toBe('project-project-a')
    expect(workspacePanelScreenId(null, null)).toBe('workspace')
  })

  it('keeps profiles, screens, and nested groups isolated', () => {
    expect(panelLayoutStorageId('profile-a', 'tab-a', 'pane-project-a')).toBe(
      'arco-panels:profile-a:tab-a:pane-project-a',
    )
    expect(panelLayoutStorageId('profile-a', 'tab-b', 'pane-project-a')).not.toBe(
      panelLayoutStorageId('profile-a', 'tab-a', 'pane-project-a'),
    )
    expect(panelLayoutStorageId('profile-b', 'tab-a', 'pane-project-a')).not.toBe(
      panelLayoutStorageId('profile-a', 'tab-a', 'pane-project-a'),
    )
  })
})

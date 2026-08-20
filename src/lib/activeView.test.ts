import { describe, expect, it } from 'vitest'

import { rendersWorkspace } from './activeView'
import { AGENT_SANDBOX_ENABLED } from './featureFlags'

describe('rendersWorkspace', () => {
  it('answers for the views that replace the workspace', () => {
    expect(rendersWorkspace('home')).toBe(false)
    expect(rendersWorkspace('agentCanvas')).toBe(false)
  })

  it('keeps the workspace on screen when the view it names cannot be rendered', () => {
    // The sandbox sits behind a flag; with the flag off the app shows the
    // workspace, and its panes have to stream as if it were the named view.
    expect(rendersWorkspace('agentSandbox')).toBe(!AGENT_SANDBOX_ENABLED)
    expect(rendersWorkspace('workspace')).toBe(true)
  })
})

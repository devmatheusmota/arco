import { afterEach, describe, expect, it } from 'vitest'

import { cliPathMatchesAgent, configuredLauncherFor, setCliPathSource } from './agentCliPath'

describe('cliPathMatchesAgent', () => {
  it('accepts the Antigravity CLI and rejects the desktop application', () => {
    expect(cliPathMatchesAgent('antigravity', String.raw`C:\Tools\agy.exe`)).toBe(true)
    expect(cliPathMatchesAgent('antigravity', String.raw`C:\Apps\Antigravity.exe`)).toBe(false)
  })

  it('accepts Windows launcher extensions for GitHub Copilot', () => {
    expect(cliPathMatchesAgent('copilot', String.raw`C:\npm\copilot.cmd`)).toBe(true)
  })
})

describe('configuredLauncherFor — the executable a restart runs', () => {
  afterEach(() => setCliPathSource(() => ({})))

  it('runs the configured CLI instead of whatever PATH finds', () => {
    setCliPathSource(() => ({ claude: '/opt/tools/claude', antigravity: '/opt/tools/agy' }))

    expect(configuredLauncherFor('claude')).toBe('/opt/tools/claude')
    expect(configuredLauncherFor('agy')).toBe('/opt/tools/agy')
  })

  it('leaves PATH in charge when nothing is configured or the path names another program', () => {
    setCliPathSource(() => ({ antigravity: String.raw`C:\Apps\Antigravity.exe` }))

    expect(configuredLauncherFor('codex')).toBeUndefined()
    expect(configuredLauncherFor('agy')).toBeUndefined()
    expect(configuredLauncherFor(undefined)).toBeUndefined()
  })
})

import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import { CHANGELOG_RELEASES, CURRENT_VERSION } from './changelogData'

const require = createRequire(import.meta.url)
const { version: packageVersion } = require('../../package.json') as { version: string }

const rank = (version: string) =>
  version.split('.').reduce((total, part) => total * 1000 + Number(part), 0)

/**
 * The "What's new" dialog reads this list, and nothing until now noticed when a
 * release went out without an entry — which is how 2.1.2 and 2.2.0 shipped while
 * the dialog still announced 2.1.1, telling the user the update had not arrived.
 */
describe('CHANGELOG_RELEASES', () => {
  it('has an entry for the version being shipped', () => {
    const versions = CHANGELOG_RELEASES.map((release) => release.version)
    expect(versions).toContain(packageVersion)
  })

  // The entry is written before the version is cut, so the list is allowed to be
  // one step ahead of package.json — never behind it, which is the failure this
  // guards: the dialog announcing a version older than the app it ships in.
  it('never leads with a version older than the one being shipped', () => {
    expect(rank(CURRENT_VERSION)).toBeGreaterThanOrEqual(rank(packageVersion))
  })

  it('is ordered newest first', () => {
    const ranks = CHANGELOG_RELEASES.map((release) => rank(release.version))
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a))
  })

  it('never lists the same version twice', () => {
    const versions = CHANGELOG_RELEASES.map((release) => release.version)
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('gives every release at least one note', () => {
    for (const release of CHANGELOG_RELEASES) {
      expect(release.noteKeys.length, `v${release.version} has no notes`).toBeGreaterThan(0)
    }
  })
})

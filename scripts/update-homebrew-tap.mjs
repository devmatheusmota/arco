// Points the Homebrew cask at the release that just shipped.
//
// macOS installs through `brew install --cask arco`, which reads
// `Casks/arco.rb` from github.com/devmatheusmota/homebrew-arco. A tap nobody
// updates is worse than no tap at all: `brew upgrade` reports the machine as
// current while it sits on a version from months ago.
//
// The checksums come from the digests GitHub already computed for the release
// assets, so the .dmg files are never downloaded — the whole update is three
// API calls and a commit.
//
// Needs a token that can write to the tap repository: GITHUB_TOKEN is scoped to
// the repository that runs the workflow and cannot push to another one. Without
// it the script says so and stops, rather than failing a release that is
// otherwise complete.

const REPO = 'devmatheusmota/arco'
const TAP = 'devmatheusmota/homebrew-arco'
const CASK_PATH = 'Casks/arco.rb'

const dryRun = process.argv.includes('--dry-run')
const tag = process.argv.find((arg, index) => index > 1 && !arg.startsWith('--'))?.trim()
if (!tag) {
  console.error('usage: node scripts/update-homebrew-tap.mjs <tag>')
  process.exit(1)
}
const version = tag.replace(/^v/, '')

const token = (process.env.GITHUB_TOKEN ?? '').trim()
if (!token) {
  console.log(
    '[homebrew] no token for the tap — skipping.\n' +
      `[homebrew] add a HOMEBREW_TAP_TOKEN secret with write access to ${TAP} to enable this step.`,
  )
  process.exit(0)
}

async function api(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!response.ok) {
    throw new Error(
      `${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`,
    )
  }
  return response.json()
}

/** The sha256 GitHub stores for an asset, without downloading it. */
function digestOf(assets, name) {
  const asset = assets.find((item) => item.name === name)
  if (!asset) throw new Error(`release ${tag} has no ${name}`)
  const digest = String(asset.digest ?? '')
  if (!digest.startsWith('sha256:')) {
    throw new Error(`asset ${name} carries no sha256 digest (${digest || 'none'})`)
  }
  return digest.slice('sha256:'.length)
}

const release = await api(`/repos/${REPO}/releases/tags/${tag}`)
const arm = digestOf(release.assets, `Arco-${version}-arm64.dmg`)
const intel = digestOf(release.assets, `Arco-${version}-x64.dmg`)

const current = await api(`/repos/${TAP}/contents/${CASK_PATH}`)
const cask = Buffer.from(current.content, 'base64').toString('utf8')

const updated = cask
  .replace(/version "(\d+\.\d+\.\d+)"/, `version "${version}"`)
  .replace(/sha256 arm:\s+"[0-9a-f]{64}"/, `sha256 arm:   "${arm}"`)
  .replace(/intel: "[0-9a-f]{64}"/, `intel: "${intel}"`)

if (
  !updated.includes(`version "${version}"`) ||
  !updated.includes(arm) ||
  !updated.includes(intel)
) {
  throw new Error(
    'the cask did not match the expected shape; update scripts/update-homebrew-tap.mjs',
  )
}
if (updated === cask) {
  console.log(`[homebrew] ${TAP} already points at ${version}`)
  process.exit(0)
}
if (dryRun) {
  console.log(
    `[homebrew] would write ${version} (arm ${arm.slice(0, 12)}…, intel ${intel.slice(0, 12)}…)`,
  )
  process.exit(0)
}

await api(`/repos/${TAP}/contents/${CASK_PATH}`, {
  method: 'PUT',
  body: JSON.stringify({
    message: `Arco ${version}`,
    content: Buffer.from(updated, 'utf8').toString('base64'),
    sha: current.sha,
  }),
})

console.log(`[homebrew] ${TAP} now points at ${version}`)

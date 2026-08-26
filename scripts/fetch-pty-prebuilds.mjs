// Fills in the macOS terminal binaries node-pty does not ship on npm.
//
// `@homebridge/node-pty-prebuilt-multiarch` publishes prebuilds for Linux in the
// package itself, but on macOS its install script downloads a single binary for
// whatever Node ran `npm install` and drops it in `build/Release`. The packaged
// app then carries that one ABI, while the PTY host runs under the Node the user
// has — so a release built on Node 20 gives a black terminal to everyone on 22
// or 24, and the app can only say the host exited.
//
// The package already resolves `prebuilds/<platform>-<arch>/node.abi<N>.node`
// ahead of `build/Release`, so filling that folder makes one build work across
// Node versions. `spawn-helper`, the other half of the macOS path, is not ABI
// dependent and stays where the install script put it.
//
// Run before packaging. It is a no-op off macOS, and never fails the build: a
// missing prebuild leaves the app exactly as it is today.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = path.join(ROOT, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch')

// NODE_MODULE_VERSION of the Node versions a user is likely to have. Anything
// missing from the release is skipped, so this list can lead the ecosystem.
const TARGET_ABIS = [115, 127, 137, 141]

function releaseUrl(version, abi, platform, arch) {
  return (
    'https://github.com/homebridge/node-pty-prebuilt-multiarch/releases/download/' +
    `v${version}/node-pty-prebuilt-multiarch-v${version}-node-v${abi}-${platform}-${arch}.tar.gz`
  )
}

async function download(url, file) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) return false
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()))
  return true
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log('[pty-prebuilds] not macOS — nothing to do')
    return
  }
  if (!fs.existsSync(PACKAGE)) {
    console.log('[pty-prebuilds] node-pty is not installed — skipping')
    return
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8'))
  // `npm_config_arch` is what electron-builder sets when it cross-packages the
  // Intel build; without it a runner would only ever fetch its own arch.
  const arch = process.env.npm_config_arch || os.arch()
  const target = path.join(PACKAGE, 'prebuilds', `darwin-${arch}`)
  fs.mkdirSync(target, { recursive: true })

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-pty-prebuilds-'))
  const fetched = []
  for (const abi of TARGET_ABIS) {
    const destination = path.join(target, `node.abi${abi}.node`)
    if (fs.existsSync(destination)) {
      fetched.push(`${abi} (already present)`)
      continue
    }
    const archive = path.join(staging, `node-v${abi}.tar.gz`)
    try {
      if (!(await download(releaseUrl(version, abi, 'darwin', arch), archive))) {
        console.log(`[pty-prebuilds] no prebuild published for ABI ${abi}`)
        continue
      }
      const extracted = path.join(staging, String(abi))
      fs.mkdirSync(extracted, { recursive: true })
      execFileSync('tar', ['xzf', archive, '-C', extracted, 'build/Release/pty.node'])
      fs.copyFileSync(path.join(extracted, 'build', 'Release', 'pty.node'), destination)
      fetched.push(String(abi))
    } catch (error) {
      console.log(`[pty-prebuilds] ABI ${abi} failed: ${String(error)}`)
    }
  }
  fs.rmSync(staging, { recursive: true, force: true })
  console.log(`[pty-prebuilds] darwin-${arch}: ${fetched.join(', ') || 'none'}`)
}

await main()

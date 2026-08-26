// Fixes node-pty's asar rewrite in the installed package.
//
// On macOS node-pty starts a terminal by posix_spawning `spawn-helper`, a small
// binary it locates next to its own source. Packaged, that path runs through
// `helperPath.replace('app.asar', 'app.asar.unpacked')` — written for a module
// loaded from inside the archive. Arco's PTY host runs under the system Node,
// which cannot read an archive, so node-pty is loaded from
// `app.asar.unpacked/` and the same replace produces
// `app.asar.unpacked.unpacked/build/Release/spawn-helper`. Nothing is there,
// posix_spawn fails, and every terminal in the macOS build dies with
// `posix_spawnp failed.`
//
// The fix is to rewrite the suffix at most once. It is applied here rather than
// in Arco's own code because the path is computed when node-pty is required and
// never exposed. Runs on `postinstall`, so packaging always carries it.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = path.join(
  ROOT,
  'node_modules',
  '@homebridge',
  'node-pty-prebuilt-multiarch',
  'lib',
  'unixTerminal.js',
)

const REPLACEMENTS = [
  [
    "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
    "helperPath = helperPath.replace(/app\\.asar(?!\\.unpacked)/, 'app.asar.unpacked');",
  ],
  [
    "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
    "helperPath = helperPath.replace(/node_modules\\.asar(?!\\.unpacked)/, 'node_modules.asar.unpacked');",
  ],
]

if (!fs.existsSync(FILE)) {
  console.log('[node-pty-patch] node-pty is not installed — skipping')
  process.exit(0)
}

const before = fs.readFileSync(FILE, 'utf8')
let after = before
let applied = 0
for (const [from, to] of REPLACEMENTS) {
  if (after.includes(to)) continue
  if (!after.includes(from)) continue
  after = after.replace(from, to)
  applied += 1
}

if (after === before) {
  const patched = REPLACEMENTS.every(([, to]) => before.includes(to))
  // A `npm install` that fails here leaves the developer with nothing, so this
  // only reports. `ptySpawnHelper.test.ts` is what turns an unpatched package
  // into a red build.
  console.log(
    patched
      ? '[node-pty-patch] already applied'
      : '[node-pty-patch] the asar rewrite was not found — node-pty may have changed',
  )
  process.exit(0)
}

fs.writeFileSync(FILE, after)
console.log(`[node-pty-patch] rewrote ${applied} asar path replacement(s)`)

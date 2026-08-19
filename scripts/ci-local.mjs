#!/usr/bin/env node
/**
 * The CI, run locally, in the same order the workflow runs it.
 *
 * This exists so a commit cannot land red. `.github/workflows/ci.yml` is the
 * contract; every gate below mirrors a step of it, and the boot smoke is in here
 * because nothing else in the list loads the Electron main process — lint,
 * vitest and `tsc && vite build` all pass with it fatally broken, which is
 * exactly how v2.0.1 shipped an app that could not open.
 *
 * It checks the working tree, not the index: a partial commit is validated
 * together with whatever else is uncommitted around it. Good enough for the
 * failure this exists to stop — a red main — and cheaper than stashing.
 *
 * The Rust check is not mirrored: `src-tauri/` is the legacy shell, `cargo check`
 * takes minutes, and nothing in a normal change touches it. CI still runs it.
 *
 * Escapes, for when the gate is wrong and you know why:
 *   git commit --no-verify     skip the hook entirely
 *   ARCO_SKIP_SMOKE=1          run everything but the boot smoke
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const steps = [
  ['Lint', 'npm run lint'],
  ['Formatting', 'npm run format:check'],
  ['Unit tests', 'npm test'],
  ['Typecheck and build', 'npm run build'],
]

/** The smoke needs a display; on a headless machine xvfb provides one. */
function smokeCommand() {
  if (process.env.ARCO_SKIP_SMOKE === '1') return null
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return 'npm run smoke:boot'
  const hasXvfb = existsSync('/usr/bin/xvfb-run')
  if (hasXvfb) return 'xvfb-run -a npm run smoke:boot'
  console.warn('  ! no display and no xvfb-run: skipping the boot smoke')
  return null
}

const smoke = smokeCommand()
if (smoke) steps.push(['Boot smoke', smoke])

const startedAt = Date.now()
for (const [name, command] of steps) {
  process.stdout.write(`\n▸ ${name}\n`)
  try {
    execSync(command, { stdio: 'inherit' })
  } catch {
    console.error(
      `\n✗ ${name} failed. The same step fails in CI — fix it, or commit with --no-verify.\n`,
    )
    process.exit(1)
  }
}
console.log(`\n✓ CI passed locally in ${Math.round((Date.now() - startedAt) / 1000)}s\n`)

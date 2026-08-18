// Paths handed to the app from the command line (`arco <dir>`, the CLI shim, or
// a second launch), queued until the window is ready to open them.

const fs = require('node:fs')
const path = require('node:path')

const queue = []

/** Reads `--open-path <dir>` or a bare directory argument out of an argv. */
function collectFromArgv(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    let candidate = null
    if (argument === '--open-path') candidate = argv[index + 1]
    else if (argument.startsWith('--open-path=')) candidate = argument.slice(12)
    else if (index > 0 && !argument.startsWith('-')) candidate = argument
    if (!candidate) continue
    const resolved = path.resolve(candidate)
    try {
      if (fs.statSync(resolved).isDirectory() && !queue.includes(resolved)) queue.push(resolved)
    } catch {}
  }
}

function takePendingOpen() {
  return queue.shift() ?? null
}

module.exports = { collectFromArgv, takePendingOpen }

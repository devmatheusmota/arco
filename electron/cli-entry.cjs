// The terminal subcommands, answered without a browser.
//
// `main.cjs` re-executes the app binary with ELECTRON_RUN_AS_NODE pointing
// here, so `arco todo`, `arco session`, `arco help` and `arco --version` run in
// a plain Node process: no Chromium, no window layer, nothing that opens a
// connection to a display. The comment in `main.cjs` says why the graphical
// path could not be turned off from inside the process that already started it.

const { handleCli } = require('./cli.cjs')

// There is no window to fall back to from here: this file is only reached for
// an argv `handlesCli` already claimed, and a Node process cannot open one.
if (!handleCli(process.argv, (code) => process.exit(code))) {
  require('node:fs').writeSync(2, 'arco: subcomando nao reconhecido\n')
  process.exit(1)
}

// Why the PTY host died, in words a pane can show.
//
// The native terminal binary is built for one Node ABI, and the host runs under
// whatever Node the machine has — the packaged app carries the ABI of the
// machine that built it. When the two disagree the host exits before reading a
// single request, and every pane reported `pty host exited`: a message that
// names neither the cause nor the fix.

/** Node major that ships a given NODE_MODULE_VERSION, for the versions Arco targets. */
const NODE_ABI_MAJORS = { 108: 18, 115: 20, 127: 22, 131: 23, 137: 24, 141: 25 }

function explainHostFailure(text) {
  const abi = /NODE_MODULE_VERSION (\d+)\. This version of Node\.js requires[^\d]*(\d+)/s.exec(text)
  if (abi) {
    const built = NODE_ABI_MAJORS[Number(abi[1])]
    const running = NODE_ABI_MAJORS[Number(abi[2])]
    const builtLabel = built ? `Node ${built}` : `Node ABI ${abi[1]}`
    const runningLabel = running ? `Node ${running}` : `Node ABI ${abi[2]}`
    return `the terminal binary was built for ${builtLabel} and this machine runs ${runningLabel}; install ${builtLabel} and reopen Arco`
  }
  return text.split('\n')[0]
}

module.exports = { explainHostFailure, NODE_ABI_MAJORS }

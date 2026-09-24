// Restarting a terminal: the process behind an id is replaced by a new one.
//
// The host keeps a session under its id until the process reports its exit, and
// a hangup is not an exit: an agent answers SIGHUP by flushing its transcript
// and running its own shutdown, which takes a few hundred milliseconds. Spawning
// right after the kill found the dying session still registered, the host handed
// it back as "reused", and nothing new started — a restart of a live pane only
// ever killed it, taking the conversation it was in along.

const EXIT_POLL_MS = 50
// The host sends SIGKILL to whatever ignored the hangup after two seconds.
const EXIT_WAIT_MS = 3_000

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function restartPty(ptyHost, args, { pollMs = EXIT_POLL_MS, waitMs = EXIT_WAIT_MS } = {}) {
  const killed = await ptyHost.request('kill_pty', { id: args.id, reason: 'restarted' })
  if (killed) {
    const deadline = Date.now() + waitMs
    while (await ptyHost.request('pty_exists', { id: args.id })) {
      if (Date.now() >= deadline) {
        throw new Error(`the previous process of ${args.id} did not exit`)
      }
      await wait(pollMs)
    }
  }
  return ptyHost.request('spawn_pty', {
    id: args.id,
    command: args.command,
    args: args.extraArgs ?? [],
    cwd: args.cwd,
    env: args.env,
    cols: args.cols,
    rows: args.rows,
    launcherOverride: args.launcherOverride,
  })
}

module.exports = { restartPty }

// Turning a path inside `app.asar` into the real file on disk.
//
// Anything the system Node has to read — the PTY host, the speech host, the
// native modules they load — is listed in `asarUnpack`, so electron-builder
// writes it to `app.asar.unpacked/` and leaves the archive path pointing at it.
// Rewriting `app.asar` to `app.asar.unpacked` is how that path is followed.
//
// The rewrite has to be conditional. A file read from the unpacked directory
// already carries the suffix, and replacing blindly turns it into
// `app.asar.unpacked.unpacked` — a directory that does not exist. node-pty
// replaces blindly, which is why every packaged macOS build failed to find its
// terminal helper: the PTY host runs under system Node, out of the unpacked
// directory, so node-pty always doubled the suffix.

/** The `app.asar` path a real file lives at, rewritten at most once. */
function unpackedPath(file) {
  return String(file)
    .replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')
    .replace(/node_modules\.asar(?!\.unpacked)/, 'node_modules.asar.unpacked')
}

module.exports = { unpackedPath }

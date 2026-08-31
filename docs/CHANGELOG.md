# Changelog

Notable user-facing changes to **Alethe** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/). Dates use UTC.

> **Rule:** every feature addition, change, or removal must be recorded under
> `[Unreleased]` in the same task. During a release, `[Unreleased]` becomes the new
> dated version and a new empty `[Unreleased]` section is added at the top.

## [Unreleased]

## [2.13.3] — 2026-08-31

### Fixed

- The activity heatmap counts messages again, instead of reading `NaN` and painting every day
  as a peak. The graph asks for a message count per day; the backend answered with a session
  and token tally under different names, so every cell divided `undefined` by `undefined` — and
  because no comparison against `NaN` is ever true, the intensity fell through to the darkest
  shade. The header read `NaN messages`, `NaN%` and `0d streak` over a solid orange grid. Days
  are counted from each message's own timestamp, so a conversation resumed today no longer moves
  its whole history onto today, the window is zero-filled so a quiet day is a gap in the graph
  rather than a shifted column, and Codex and OpenCode are counted alongside Claude as the
  widget always claimed.
- Time & focus reports the day instead of zeros. Every tick of the tracker was being appended to
  disk raw and never aggregated, so the dashboard asked for totals and got a shape it did not
  recognize: `0m` across active focus, agent wall time, background work and focused idle, with
  "No time recorded in this period" under both breakdowns. Ticks are folded into daily totals as
  they arrive — wall-clock time kept apart from summed agent time, so two agents working through
  the same minute spend one minute of the day and two of agent time. The ticks still on disk are
  folded in on first read, so today and yesterday come back rather than being discarded with the
  format.
- Memory analytics stops telling a Mac or a Linux machine about its Windows memory. Seven strings
  in that dialog were written when Arco only shipped for Windows and still named it — the
  critical-memory banner, the two diagnostics and the three health bodies. They name the machine
  now. The one line that still says Windows is the orphan-process guard, which really is a
  Windows Job Object.
- The low-memory warning stops firing on a machine that has plenty. Available memory was read
  from `os.freemem()`, which counts only pages nothing has touched — on macOS that is close to
  zero by design, so a healthy 16 GB Mac was reported as having 419 MB left and the dialog called
  it critical. Linux answers with `MemAvailable` and macOS adds up the pages the kernel can
  reclaim, which is what both systems mean by available.
- Terminals report their real memory on macOS. Every per-process number came from `/proc`, which
  only Linux has, so each terminal showed zero processes and 0.0 MB, and the breakdown concluded
  the app itself held 100% of the memory in use. The process table is read from `ps` where there
  is no `/proc` — one call per sampling cycle, shared across every terminal.
- The dashboard no longer freezes the terminals while it refreshes. Reading a quarter of a year
  of transcripts took about three seconds, and it ran in one blocking pass in the process that
  also carries every keystroke and every byte of terminal output. The scan now yields as it goes:
  the longest uninterrupted block it holds went from 2.6s to 43ms.

## [2.13.2] — 2026-08-31

### Fixed

- Codex panes take the name of the conversation, the way Claude panes already did. A Codex pane
  sat under the placeholder it was created with — `codex` — for the life of the session, because
  the sidebar only ever asked Claude for a title. It now reads the thread name Codex writes in
  `session_index.jsonl`, updating as Codex renames the thread, and falls back to the first prompt
  someone typed while the thread is still unnamed.
- Codex history, resume and pane naming find the sessions on disk again. Codex files a
  conversation under `sessions/<year>/<month>/<day>`, and Arco was listing only the top of that
  directory, where there is nothing but the year — so every lookup answered "no sessions". Recent
  chats came up empty for Codex, a reopened pane could not resume the conversation it had, and a
  new one never learned its own session id. The listing now walks the tree, keeps the sessions
  started in the project's directory, and reads each conversation's id from its own header.
- The Codex usage widget shows real numbers again. Codex renamed every field of the answer it
  gives to `account/rateLimits/read` and started dating a window in seconds, so Arco read nothing
  it recognized and drew a flat 0% with no reset time — while `/status` inside Codex reported the
  quota correctly. Both spellings are now read, so the widget also keeps working against an older
  Codex on the machine.
- Terminal subcommands no longer print an X11 warning over their own output. `arco todo`,
  `arco session`, `arco help` and `arco --version` share the app binary, so Chromium comes up
  before Arco reads the arguments, and a moment later it launched a GPU process that opened a
  connection to the display. On a Wayland session whose xauth cookie has been recycled — the
  normal state of a GNOME desktop after a while — libX11 answered with `Authorization required,
  but no authorization protocol specified` on the command's stderr, so a successful `arco todo
  list` looked like a failure to any script or agent capturing `2>&1`. Nothing on that path
  draws, so the GPU process is now refused when the binary was started to answer a subcommand,
  and stderr carries only what the command itself has to say.

## [2.13.1] — 2026-08-26

### Fixed

- Terminals start on macOS. node-pty finds the helper it spawns a shell through by rewriting
  `app.asar` to `app.asar.unpacked` in its own path — but the terminal host runs under the system
  Node and already loads it from the unpacked directory, so the rewrite ran twice and the helper
  was looked for under `app.asar.unpacked.unpacked`, where nothing exists. Every terminal in the
  macOS build died with `posix_spawnp failed.`, and clearing the quarantine flag the error blamed
  changed nothing. The rewrite now applies at most once, everywhere Arco follows an archive path
  to a real file, and a test fails the build if an installer is ever packaged without the fix.

## [2.13.0] — 2026-08-26

### Added

- macOS installs through Homebrew: `brew tap devmatheusmota/arco` then
  `brew install --cask arco`, and `brew upgrade` carries new versions from then on. The release
  workflow updates the tap as soon as both macOS installers are attached, reading the checksums
  from the digests GitHub already computed rather than downloading anything. The cask installs
  Node — terminals need it — and clears the quarantine flag macOS puts on every file inside an
  unsigned download, which is what stopped terminals from starting there.

### Fixed

- A task linked to a session from the command line shows that session on the row. `arco todo
  --session current` and the ▶ button write the link in different places, and only the second one
  was ever drawn — two tasks pointing at the same pane showed one session between them. Both are
  now read as the same thing, the newest first, and unlinking removes whichever one the row was
  drawing.
- The session badge on a task row is a button: one click brings that pane to the front. Reaching a
  session meant expanding the task and clicking the link at the bottom of it.

## [2.12.1] — 2026-08-26

### Fixed

- Terminals start on macOS where Gatekeeper was blocking them. The macOS build spawns every
  terminal through a small helper binary that ships with node-pty, and on an unsigned download that
  file carries the quarantine flag — the pane then showed `Failed to start PTY: posix_spawnp
  failed.` and nothing else, whatever the actual cause. Arco now clears the flag itself before the
  first terminal, retries a spawn that hit it, and when it still cannot run the helper says which
  of the four possible reasons applies and prints the `xattr` command that fixes it.
- The macOS installers carry the terminal binary for Node 20, 22 and 24 instead of only the version
  the release was built with. Terminals run under the Node installed on the machine, so a mismatch
  used to leave every pane dead with `pty host exited`. When one still happens — on Windows, which
  ships a single build — the message now names the Node that was expected and the one that is
  installed.
- An agent that cannot get its worktree says why. The toast still carries the short version, and
  the full reason, including a `git` that is not installed at all, is written to `app-events.log`.

## [2.12.0] — 2026-08-25

### Added

- A pull request chip stored with the wrong project repairs itself. Once per app start, every task
  carrying a pull request asks Azure DevOps where that pull request actually lives, and the
  reference is rewritten when the stored one disagrees — including the ones an older build saved
  with a repository GUID. Boards and code sit in separate projects here, so a reference written
  from a work item URL inherits the board's project and renders a chip that opens "Repository not
  found"; the pull request is the only authority on the answer. 2.8.2 did this from inside the
  watcher and 2.9.0 removed it with the rest of the integration — this brings back the repair and
  nothing else: no polling, no status moved, no task touched that has no pull request.
- Preferences → Integrations takes a Personal Access Token again, used by that one call and nothing
  else. Left blank, the pass does not run and chips stay exactly as they were saved.

## [2.11.0] — 2026-08-25

### Added

- The GitHub sync uploads on its own. Sync your data now carries a switch and an interval — 5, 15,
  30, 60 or 180 minutes — and the shell pushes the workspace to the gist on that schedule without
  anyone pressing Upload. It is on by default at 15 minutes for an account that is already
  connected. A tick where the workspace is byte for byte what was uploaded last sends nothing, so
  an idle day costs no gist revisions and no rate limit. Three failures in a row park the timer and
  the reason appears under the buttons — a revoked token stops being retried every quarter hour.
  The schedule is kept in `github-sync.json`, outside the file being synced, so pulling on another
  machine does not carry this machine's interval over to it. Downloads stay manual: overwriting the
  local workspace is not something a timer should decide.

### Fixed

- A task's notes hold 32 000 characters instead of 4 000, and a note that does not fit is refused
  rather than stored with its tail cut off. The old ceiling was reached by a real briefing note —
  acceptance criteria, the command to run, the branch and a running log of what changed — and the
  cut happened mid-word, on save, with nothing said: `--append-notes` reported success and dropped
  what it could not fit. The command line now names the length and the limit and writes nothing,
  and the notes box in the sidebar stops accepting past the ceiling instead of losing the excess
  when it saves.
- Sync failures now say what went wrong in your language. "Nothing uploaded yet" and "the Gist has
  no projects data" reached the dialog as raw English from the shell and fell through to the
  generic "Sync failed" line, which is the one message that tells you nothing.

## [2.10.1] — 2026-08-24

### Fixed

- A task linked to a work item and a pull request that live in different Azure DevOps projects now
  opens both. The board sits in `Plataforma EMR` and the code in `SOA` or `agentic-product-os`, and
  merging the two `--ado` URLs let whichever arrived second decide the project for both chips — so
  one of them always pointed at a project that does not hold it, and ADO answered "Repository not
  found". Each side now keeps the project it was given. Until 2.9.0 the watcher repaired this after
  the fact; with the watcher gone, `--ado` had to get it right on its own.

## [2.10.0] — 2026-08-24

### Added

- A task can point at an Azure DevOps work item and pull request again. The row shows the `#22447`
  and `!10681` chips — a click opens the page in the browser, Alt/Meta+click opens it inside the
  app — and `arco todo --ado <url|id>` and `arco todo edit <ref> --ado|--clear-ado` set and clear
  the link. Preferences → Integrations takes an organization and a default project again, so a bare
  `#22447` resolves without the full URL. 2.9.0 removed this along with the watcher; only the
  watcher was meant to go. What did not come back is the polling: nothing reads the board, nothing
  moves a task on its own, and no personal access token is asked for or used. Links stored before
  2.9.0 were dropped when that version read the task file, so they have to be set again.

### Removed

- Spotify Now Playing is gone. The dock on Home and the row above the sidebar profile, the
  Preferences → Integrations section asking for a Client ID and a Client Secret, and the polling
  behind them were all removed. Neither widget had shown anything since v2: this shell answers
  "not connected" to every Spotify call, so the credentials saved in Preferences reached nothing.
- Discord Rich Presence is gone, along with its on/off switch under Preferences → Integrations.
  It was equally inert here — the presence call was a no-op in this shell, so nothing was ever
  published to a Discord profile.

## [2.9.0] — 2026-08-24

### Removed

- The Azure DevOps integration is gone. A task no longer links to a work item or a pull request,
  the `#22447` and `!10681` chips and the eye icon left the task row, the watcher that polled the
  board and moved tasks on its own no longer runs, and Preferences → Integrations no longer asks
  for an organization, a project, a personal access token or a poll interval. On the command line,
  `arco todo` and `arco todo edit` dropped `--ado`, `--clear-ado`, `--watch` and `--no-watch`, and
  `arco todo show` no longer prints a linked card. References already saved are discarded the next
  time the task file is read — nothing else about the task changes.

## [2.8.2] — 2026-08-21

### Fixed

- The pull request chip on a task now opens the pull request. It was built with the work item's
  project, and board and code sit in different Azure DevOps projects here — a card in
  `Plataforma EMR` pointing at a pull request in the `EGA` repository, which lives in `Eduardo` —
  so the link answered "Repository not found". The watcher now asks Azure DevOps where the pull
  request actually lives and repairs the reference it finds wrong, including the ones an older
  build stored as a repository GUID.

## [2.8.1] — 2026-08-21

### Changed

- The task the session in front is working on is marked by the highlight alone. The chip repeating
  it in words next to the status and the tags was noise on a row that already had enough of it.

## [2.8.0] — 2026-08-21

### Added

- A task can be tied to the session working on it. `arco todo add` and `arco todo edit` take
  `--session <id|current>`, `arco todo edit` takes `--clear-session`, and `arco session` takes
  `--todo <ref>` so a session is born already attached to its task. The board used to be right
  about what was being done and silent about who was doing it: a task gave no way back to the
  session that produced it, and a session no way to say which task it was on. `current` is
  answered by the pane's own id and, failing that, by the directory the command ran in; two
  sessions sharing a tree cannot be told apart that way, so the command asks for an explicit id
  rather than linking the wrong one. The link is kept after the session ends — that history is
  what it is for. `arco todo list` marks the tasks a session owns, `arco todo show` names it, and
  `arco todo show --json` carries it as `sessionId`.
- Every terminal exports `ARCO_SESSION_ID`, so anything running inside a pane can name the session
  it belongs to.
- The task list marks the task the session in front is working on — the row carries the same
  highlight a selected item gets anywhere else in the app, plus a chip that says it in words.
  The board said what was being done and the workspace said where, and the two never met on
  screen: finding which task a session belonged to meant opening tasks one at a time.

### Fixed

- A new session starts on its own again. A pane had no process id until it spawned, and the check
  that decides whether a session is on screen only knew panes by that id — so a brand-new session
  concluded nobody was looking at it and waited, showing "This session has not started yet" with
  the pane in full view. Only the button got it going.
- A task created with `arco todo add` lands in the project the terminal is standing in, instead of
  whichever project the window happened to have open.
- `arco --version` also reports the version of the app that is answering when it differs from the
  binary's — an update that lands while the old window is still open used to leave the two apart
  with nothing saying so.

## [2.7.0] — 2026-08-20

### Changed

- The interface ships with its own font. The app has named Inter for a long time while nothing
  loaded it, so every machine picked a different substitute and the same build looked different on
  Windows and on Linux. The monospace used in counters and chips had the same problem — none of the
  three fonts it asked for exist on Linux, so it fell back to Courier.
- Shadows and dialog backdrops follow the theme instead of being painted with black. On the light
  themes a black shadow read as dirt; each theme now casts a shadow made of its own dark end, and
  the four different backdrops the dialogs used became one.
- The light and ember themes have their own agent colours and focus ring. Both were silently
  borrowing the dark theme's, which is why an agent looked the same shade on a white page.

- The interface is drawn once. `Visual style` used to pick between two whole implementations of the
  sidebar and a hundred-odd override blocks scattered through the app, so a fix applied to one look
  rarely reached the other. The preference stays, but it now only sets density.
- Type, spacing and row heights come from one scale. Nothing readable is smaller than 12px — the
  app used to have text at 8, 9 and 10px, and sizes like 12.5px that belonged to no scale — and
  rows, controls and toolbars share the same heights instead of each screen inventing its own.
- Selection says one thing once. A selected tab used to stack a fill, a border, an underline, a glow
  and a one-pixel lift, while a selected project in the sidebar was told only by a slightly bolder
  name — and a selected row in the tree was darker than the row under the pointer. Everything
  selectable now gets the same wash and the same left rail.
- Status and work-item chips in the Todo list are text with a dot instead of filled capsules with
  coloured borders. Colour is left to what it means: an agent working, waiting or in error.
- Icons come in three sizes, all even. There were sixteen, half of them odd, which is why a
  1px-stroke icon looked blurred.
- The home screen no longer uses frosted glass. Every translucent, blurred panel became a solid
  surface, and the ASCII backdrop dropped to a texture instead of near full strength.

### Fixed

- Keyboard focus is visible everywhere. Ten of seventy-one stylesheets styled `:focus-visible`
  against twenty-five that removed the outline and put nothing in its place.
- Several panels lost their colour, background or border entirely because they asked for colour
  names the app never defined — the private-window notice in the browser dialog was one of them.
- Typing, switching sessions and repainting no longer carry a transition applied to every element
  in the window, terminal contents included. The fade when you change theme is still there; it now
  runs only while the theme is changing.
- The interface respects the system setting for reduced motion.

## [2.6.6] — 2026-08-20

### Added

- Starting a session is now recorded step by step in `app-events.log`: every boot phase of a pane
  (preparing, queued, spawning, attaching, ready) with how long it took, plus the reason a pane
  stopped short — waiting to be opened, abandoned in the spawn queue, or a launch that threw. The
  terminal host reports too: what it spawned and with which pid, a command missing from `PATH`, a
  working directory that no longer exists, and every exit with its code and how long the process
  ran. Its stderr, which used to go to a console nobody could reach, lands in the same file, and a
  command that fails behind the scenes leaves an `invoke.error` line instead of failing silently.
- A pane that has not finished starting after twenty seconds says so, names the step it stopped on,
  and offers to try again.

### Fixed

- A session opened from the tab bar could stay black forever. Whether a pane starts its session
  depends on it being on screen, and that answer was read from a value that only refreshes on the
  next render — so a pane that arrived while its own start was still being decided armed itself to
  wait for an event that had already passed. It now asks whether it is on screen at the moment it
  decides, and the wait is re-armed independently of the first render.
- A session that has not started yet shows a button to start it, instead of an empty black pane with
  nothing to click.
- An interrupted agent worktree is no longer handed to the next session as if it were complete. The
  directory was taken as proof the worktree existed, so a checkout git never finished registering
  was reused; what is left of it is now moved aside and a real worktree takes its place.

## [2.6.5] — 2026-08-20

### Fixed

- Closing a session, or the app, now takes the agent's own processes down with it. The previous fix
  stopped the process that hosts the terminals, but stopping it only moved the leak one level down:
  each terminal is a session of its own, so the agent inside it — and the MCP servers the agent
  brought up, which are what hold the memory — survived and were handed to the system. Killing the
  host by hand freed 4.5 GB that closing the window had not. Everything a terminal started is now
  hung up together, and whatever ignores the hangup is killed two seconds later.

## [2.6.4] — 2026-08-20

### Fixed

- Closing Arco now shuts its terminals down. The process that hosts every PTY outlived the window:
  it was handed over to the system instead of being stopped, and it kept the sessions it owned — and
  the agents inside them — running for the rest of the login session. Here that meant 7 GB still
  held by two Claude sessions from a window closed twenty minutes earlier, and every open-and-close
  cycle added another host on top. The host is stopped with the app, and it also exits on its own
  when the app that started it goes away, so a crash does not leak it either.

## [2.6.3] — 2026-08-20

### Changed

- A session starts when you open it, not when the app does. Opening a project used to start every
  session it holds at once, and a coding agent is not one process — each one brings up its MCP
  servers, which measured at about 3 GB per session here: ten sessions took 32 GB and the machine
  went to swap before the window had finished drawing. Only the session on screen — and the terminal
  beside it — starts now; the others wait in the tab bar and start when picked, which takes a couple
  of seconds. A session that was given something to run still starts on its own, watched or not, and
  a session already running is never touched.

## [2.6.2] — 2026-08-20

### Fixed

- A session picked from the tab bar shows its screen again. Every session of a project is mounted,
  so all but the one in front attach to their agent while hidden — and a pane that attaches hidden
  is never given the screen its agent is already on. It stayed blank until that agent happened to
  print more than the host retains, which for a project holding several idle sessions never came:
  every tab opened onto an empty terminal. A pane that reaches the screen without one now asks the
  host for it.
- A tab is named after the conversation it holds, like the sidebar row for the same session. Nine
  Claude sessions of one project all read `claude`, so the tab bar said nothing about which was
  which and nothing tied a tab to the session listed in the sidebar.
- Sessions stop going black after a long stretch of switching between them. The GPU context of a
  pane leaving the screen was only released when the browser got around to collecting its canvas,
  and a WebView caps how many contexts a page may hold: past the cap it takes the oldest, which are
  the ones a visible pane is drawing from. The context is handed back with the pane now.
- Typing goes to the session on screen right after a project opens. Every session mounting at once
  meant every one of them claiming the keyboard, and the last to finish won.

## [2.6.1] — 2026-08-19

### Added

- The CI now runs before every push, on your machine. A pre-push hook runs the same sequence the
  workflow does — lint, formatting, tests, typecheck, build and the Electron boot smoke — in about
  45 seconds, so a red branch is caught before anyone else pulls it. `git push --no-verify` skips it
  when the gate is wrong.

### Fixed

- The boot smoke checks what the `arco` command actually receives. It still asserted the shape the
  route answered before the CLI was rewritten — a bare list instead of the current envelope — and it
  asked the binary for a listing without `--json`, then failed on the human-readable table it got
  back. The job had been red since, which is how it stopped being read.

- A session tab is named after the conversation again, not after the agent. Two Claude sessions in
  the same project both read `claude`, with nothing to tell them apart — the tab bar was reading the
  session's fallback name while the sidebar was already showing the conversation title. Both use the
  same name now.
- Switching sessions is immediate again. Only the session on screen kept streaming, so the ones
  behind it collected their output in a throttled digest and handed it over in one burst when picked,
  right as the pane was also rebuilding its GPU context. Every session of the open project streams
  continuously now — they are all mounted and all the same size, so there is nothing to catch up on —
  while the GPU context still follows what is actually painted.

## [2.6.0] — 2026-08-19

### Removed

- Groups of projects are gone, along with subgroups, group tabs, the archived-groups list and
  `Ctrl+Shift+G`. The sidebar is a flat, reorderable list of projects, and a project that lived
  inside a group keeps the position it had on screen. Suspending is still there, one project at a
  time, from the project's own context menu — what is gone is doing it to several at once.

### Changed

- A project shows one session at a time. The grid is gone, and so are the layout modes, the layout
  designer and the pane blocks built by shift-clicking: every session of a project is now a tab in a
  bar above the workspace, and the one you pick fills the screen. A pane and its sub-tabs used to be
  two layers of tabs; they are one row now, named after the session. Sessions that are not on screen
  stay loaded and keep the same size as the one that is, so switching tabs starts nothing and resizes
  nothing.
- A single terminal can sit beside the active session, for running a command without leaving what you
  are reading. Only a terminal is accepted there, and only one at a time.
- `Ctrl+W` closes the session on screen. It used to close whichever pane happened to be first in the
  container, which was rarely the one being read.

### Fixed

- A terminal no longer comes back with its text scrambled — characters from different moments landed
  interleaved on one line, and columns drifted out of alignment. A pane that reopens replays the
  output recorded on disk, but that output is relative repaints an agent emitted under whatever width
  the pane had at the time. The replay ran before the pane had been fitted and before the process on
  the other end had been told the new size, so it was re-run against a geometry nobody agreed on;
  with three or more panes open the widths differ enough for it to show every time. Geometry is now
  settled — and acknowledged by the process — before a single recorded byte is written, and a resize
  can no longer land in the middle of a replay that is still being parsed.
- A pane no longer loads a second GPU renderer over the first. Two paths attached one on mount, and
  the second disposed the first, which dropped that terminal from the texture atlas every pane in the
  workspace shares while its renderer was still drawing from it. A pane that loses its GPU context
  also gets a working renderer back on the next switch instead of staying on the slow fallback for
  good, and a pane that never gets a size no longer takes a GPU context it cannot draw with.

## [2.5.0] — 2026-08-19

### Fixed

- `arco todo` no longer turns a mistyped subcommand into a task. `arco todo show <ref>` — a command
  that did not exist — matched the "create a task from the words you typed" branch, so four attempts
  to read tasks left four tasks named after them on a real board, printed nothing and exited 0. Any
  first word that reads as a subcommand is refused now, and so is a lone short id; creating still
  works through `arco todo add "<title>"` or a plain multi-word title. An unknown option is refused
  as well, instead of ending up inside the title.
- Every `arco todo` write now says what it wrote, and fails when it did not write. Creation and
  editing answered nothing at all and always exited 0, so `--ado <id>` rejected for want of the
  Azure DevOps defaults looked exactly like a link that had been saved — the only way to know was to
  run `arco todo list` afterwards, which read the file on disk and could still be showing the state
  from before the write. Commands now wait for the app, print the resulting task, and exit non-zero
  with the reason when the app refuses.
- A bare work item id that cannot be resolved says the organization and the project are missing from
  Preferences, instead of reporting the number as unrecognized.
- `arco --version` prints the version instead of hanging until it is killed: the flag matched no
  subcommand and fell through to opening a window.
- The macOS installers stop overwriting each other. Intel and Apple Silicon are built on two runners
  that attach to the same release, and both produced `Arco-<version>.dmg` — whichever finished last
  won and the other upload failed. The architecture is now part of the file name, which also lets the
  download page say which build a person is getting.
- The command line no longer reports "o app nao esta rodando" while the window is open. The file it
  reads endpoint and token from lives in the temp directory, and once something replaced or removed
  it only a restart brought the command back; the app now rewrites it whenever it stops pointing at
  the running instance.

### Added

- `arco todo show <ref>` prints one task in full — notes, tags, priority, project and the linked
  Azure DevOps card — instead of forcing a `--json` listing to be read by hand.
- `arco todo delete <ref>` removes a task from the terminal, with `--yes` for non-interactive
  callers. Cleaning up a task created by mistake used to mean clicking the bin in the sidebar.

## [2.4.2] — 2026-08-19

### Fixed

- A pane whose session was deleted from disk comes back to its newest real conversation instead of
  opening an empty one. Repairing a pointer that named an automated run already worked, but only
  while that run's transcript still existed — deleting the transcripts left the panes with a pointer
  to nothing, and a pane in that state started a new session and saved its id over the pointer, so
  the conversation it was in became unreachable from the pane. Every unusable pointer now takes the
  same route: gone from disk, never written, or written by an automated run.

### Changed

- The session list shows the name of each conversation instead of `Session 2289fbbc`. The Electron
  build never filled in the title, so every entry fell back to its id and the message count stopped
  at 20 for everything; the list now reads the title Claude gave the conversation, falls back to the
  first prompt someone typed, and counts every message. A transcript that holds a header and no
  message — the CLI recreating a file that was deleted — is left out, since resuming it opens an
  empty conversation.

## [2.4.1] — 2026-08-19

### Fixed

- A pane no longer adopts a security review as its own conversation. `/security-review` and other
  automated runs write their transcript to the same per-project directory as the pane's session, and
  the watcher that figures out which conversation a pane started could pick one of them — the pane
  then pointed at the review, and the work it was actually doing looked lost after a restart. Only a
  conversation someone typed is adopted now, and a pane whose saved pointer already names an
  automated run drops it and comes back to its newest real conversation, which repairs panes that
  were already pointing at a review.

## [2.4.0] — 2026-08-19

### Changed

- A new agent session gets its own worktree by default. The box is checked when the modal opens and
  unchecking it is one click, which is the right way round: an agent editing the checkout everything
  else shares is the expensive mistake, and wanting the shared tree is the exception. Projects that
  already set the preference keep what they chose. The box stays hidden for a plain shell, which
  never took a worktree.

### Fixed

- The watcher no longer attaches a pull request that is already merged or abandoned. A work item
  keeps its pull request links forever, so the newest one can be a merge from months ago — a card
  still being refined ended up with a chip pointing at a pull request completed in July. Only an
  active pull request is attached now.
- The pull request chip opens the right page when the code lives in another ADO project. Boards and
  repositories routinely sit apart — a work item in "Plataforma EMR" pointing at a repository in
  "SOA" — and the chip was pairing the board's project with the code's repository, which ADO
  answers with "Repository not found". The reference now records the pull request's own project,
  and the watcher reads it from the same `ArtifactLink` it already parsed.

## [2.3.0] — 2026-08-19

### Added

- The watcher can be turned on from the command line: `--watch` on `arco todo` and on
  `arco todo edit` marks the task the same way the eye icon does, and `--no-watch` turns it off. A
  task created by an agent no longer needs a manual click to start following its card. When the
  task has no ADO reference, or the Azure DevOps PAT is missing from Preferences, the app says so
  instead of leaving a watched task that nothing polls.

### Fixed

- A pane no longer comes back showing someone else's conversation. When the session it points at
  has no transcript, it falls back to the most recent one in that directory — and automated runs
  such as `/security-review` are written to the very same directory, are usually the newest file
  there, and were therefore the ones picked. The snapshot now records whether a transcript belongs
  to a conversation someone typed, and only those are eligible.
- A pane whose directory no longer exists reopens in the nearest directory above it instead of the
  home directory. An agent worktree removed under a running pane sent it to an unrelated place,
  where its agent found none of its own sessions; the repository one level up is where the work is.

### Changed

- Reopening a pane records which conversation it came back to, and why, under `session.resume` in
  `app-events.log`. A pane can legitimately land on a different session than the one it pointed at
  — the pointer was claimed by another pane, the session was not listed for that directory, or it
  had no transcript — and until now that only reached the developer console, so a session that
  "disappeared" left no trace to read afterwards.

## [2.2.1] — 2026-08-19

### Fixed

- The "What's new" dialog lists 2.1.2 and 2.2.0. Both shipped without an entry, so an app running
  2.2.0 still announced 2.1.1 and the update looked like it had never arrived. The changelog had the
  same gap: the entries existed but were left under `[Unreleased]`, so neither version was dated.

### Changed

- Releasing is documented step by step in [`docs/RELEASE.md`](RELEASE.md), and `npm run release`
  refuses to cut a version whose changelog section or What's new entry is missing, or that leaves
  content stranded under `[Unreleased]`. The test suite fails for the same reasons, so the gap
  cannot reach a build.

## [2.2.0] — 2026-08-18

### Added

- Tasks can link to an Azure DevOps work item and pull request. The sidebar row shows a `#22447`
  (work item) and `!10681` (PR) chip when the reference is set: plain click opens the page in the
  system browser, Alt/Meta+click opens it in the app viewer. The `arco` command line takes the
  reference as `--ado <url|id>` on `arco todo` and on `arco todo edit`; `--clear-ado` removes it.
  Short forms like `#22447` and `!10681` resolve against the new "Azure DevOps" section under
  Preferences → Integrations, where the organization and default project are stored.
- An eye icon on any task with an ADO reference opts it into the watcher. Every `adoPollSecs`
  (default 300s), the watcher reads the work item and the pull request the task points at and
  moves the task on the board when the ADO side moved — Doing → in-progress, Completed → done,
  PR merged → done, PR asked-for-changes when you are the author → in-progress. A short toast
  names the task and the reason. Auth is a Personal Access Token, stored under Preferences →
  Integrations → Azure DevOps; no PAT, no polling.
- The watcher also auto-attaches a `prId` to a task whose reference so far was only the work
  item. The moment the pull request appears on the ADO side (through the work item's
  `ArtifactLink`), the sidebar starts tracking it too — the same tick that reconciles the state.
- Codex and OpenCode sessions launched from a task now start with the same "you can move this
  task" preamble Claude gets, delivered as the first chat message since those CLIs reject the
  additive system flag. Off through the same "Tell agents about the terminal command" toggle
  that already covers Claude.
- `arco todo edit <ref> --append-notes "<text>"` adds to the existing notes with a blank line as a
  separator, instead of replacing them. Useful when the morning briefing collects a new answer from
  the PM and wants the older context to survive.

## [2.1.2] — 2026-08-18

### Fixed

- `arco todo "<title>" --notes "..."` (and `--priority`) actually attaches the notes and priority
  instead of pasting the flag names into the task title. The shim parser did not know about the two
  flags, so every word after them was folded into the title and the fields never reached the store —
  and a task started from the row opened its session without the context the notes carry.

### Changed

- A release publishes as soon as the Linux build finishes, instead of waiting for every platform,
  and the apt repository is updated right there rather than after the whole workflow ends. The
  Windows and macOS installers attach themselves to the same release as each one finishes. The macOS
  Intel runner routinely sits in a queue for hours, and it was holding back the `.deb` — and with it
  the apt update — for work nobody was waiting on.

## [2.1.1] — 2026-08-18

### Fixed

- A task waiting to be started shows its status like every other one. The chip was hidden on `to do`,
  so a task with no chip could mean either "not started" or "the status feature is not there" — the
  reader had to know the rule to tell them apart. Only a completed task keeps no chip, since the
  completed section already says so.

## [2.1.0] — 2026-08-18

### Added

- Windows and macOS installers. A release now builds `.exe` (Windows x64), `.dmg`/`.zip` (macOS
  arm64 and x64) alongside the Linux `.AppImage` and `.deb`. Both are unsigned — SmartScreen and
  Gatekeeper warn on first run — and neither has been exercised the way the Linux build has, since
  the terminal and speech hosts run under the system Node and that path was only ever validated on
  Linux. A failure on those platforms no longer blocks the Linux release or the apt update.
- Tasks carry a status — to do, in progress, in review, done — shown as a chip on the row and as
  buttons in the expanded task. Finishing a task and marking it done are the same act, so the list
  still splits into open and completed exactly as before. Existing tasks keep their state: a
  completed one reads as done, everything else as to do.
- `arco todo edit <ref> …` edits an existing task from the terminal: title, tags (replace, add or
  remove), status, priority, notes and project. `arco todo status <ref> <status>` is the shorthand,
  and `arco todo list` now prints a table with the short id those commands take — `--json` keeps the
  raw output, `--status` filters. A reference is that short id or any unique piece of the title;
  when it matches more than one task, the app says which instead of guessing.
- Sessions started here are told the `arco` command exists and how to move a task through the
  board, so an agent can keep its own task current instead of leaving it to you. Claude Code only —
  Codex and OpenCode cannot take extra instructions without replacing their own. Turn it off in
  Preferences › Integrations.

### Fixed

- A pane that had been hidden while its agent was working comes back readable. Returning to it used
  to clear the terminal and replay the session's raw byte history, which re-ran repaints recorded
  under an older window size: old frames piled up on screen, characters from different moments
  landed interleaved on the same line, and the pane sometimes came back blank — a state where
  scrolling shows garbled history instead of the conversation. The pane now writes only the output
  it missed, in order, and never resets, so the agent and the terminal keep the same picture of the
  screen. Trimming the stored history also cuts on a line boundary now, so it can no longer start
  mid-escape-sequence.

## [2.0.4] — 2026-08-18

### Fixed

- `arco todo` and `arco session` answer again. The subcommands only ever existed in the shell shim
  the app installs on PATH; without it they reached the binary, matched nothing and fell through to
  opening a window, so the command hung. The binary handles them itself now. Two failures were
  hiding behind that one: output written while exiting was lost whenever it went to a pipe, and the
  argument offset assumed a shape that Chromium's own switches break.
- The Claude and Codex usage pills come back. The frontend gates its polling on window focus, and
  this shell never emitted the focus events it listens for, so a window that started in the
  background never polled again and the pills stayed empty for the rest of the session.
- Cancelling a session with uncommitted work no longer closes it anyway.
- The default profile picture is a neutral placeholder instead of the upstream project's mascot.

### Changed

- Muted text meets a 4.5:1 contrast ratio in all fourteen themes. The small 9–11px labels were
  sitting between 1.9:1 and 3.7:1, worst on the light themes; hue and saturation are unchanged, only
  lightness moved.
- Starting an agent shows that it is starting. Both the home quick launch and the new terminal
  dialog now block repeat presses, say what they are doing, and report a failure without discarding
  what you typed or chose.
- Closing a whole tab group is its own button. The group's name was the control, so clicking what
  reads as a label closed every tab in it with no warning.
- Todo items reorder from the keyboard, and editing a title saves when you click away instead of
  silently discarding it.
- The context menu takes focus when it opens, moves with the arrow keys, and returns focus where it
  came from.
- Reduced-motion preferences are respected by dialogs, terminal panes and the quick launch spinner.
- Smaller repairs: the activity heatmap rendered twice on Home; the welcome dialog offered two
  buttons that did the same thing; "Now playing" and the footer shortcuts were buttons that did
  nothing; wide dialogs could overflow a narrow window; the subtab close button was invisible to
  keyboard users; the agent picker nested buttons inside buttons; project name and path had no
  label association and Cancel kept the abandoned draft; a colour token that was never defined.


## [2.0.3] — 2026-08-18

### Fixed

- The "What's new" dialog stopped at v1.5.0. Every 2.0.x release is listed now, including the move
  to the Chromium shell and what it left behind.


## [2.0.2] — 2026-08-18

### Fixed

- The app now starts with the environment of a login shell. Launched from the desktop entry it
  inherited a bare one — no `~/.local/bin` on `PATH` and none of the variables exported from the
  user's rc files — and the consequences read as unrelated bugs: the Codex usage pill vanished
  because `codex` was "not installed", and agents started in a terminal came up missing API tokens,
  which the tools they talk to report as expired credentials. The environment is read once from an
  interactive login shell, cached for a day, and applied to the app and to every terminal it spawns,
  without overwriting anything the runtime already set.
- `arco session` and `arco todo` work again. The terminal command's subcommands live in the shim
  script, and the one this shell generates had been reduced to opening a directory; the routes they
  post to were missing from the local listener as well. Both are back, along with writing the
  endpoint file as soon as the listener binds, so the command is usable from boot rather than only
  after the interface happens to ask for it.
- Cancelling the warning about uncommitted changes now cancels. Closing a session whose worktree has
  pending work asks before deleting it, and answering no still closed the pane — keeping the files
  but losing the session the user had just chosen to keep. Nothing is touched now.


## [2.0.1] — 2026-08-18

### Fixed

- The app no longer fails to start. The agent hook listener called `crypto.randomBytes` without
  requiring `node:crypto`, so it resolved to the Web Crypto global, which has no such method. The
  exception was thrown while the module loaded, before any window existed, and the process stayed
  alive holding the single-instance lock — so launching Arco again from the desktop entry did
  nothing at all.


## [2.0.0] — 2026-08-18

### Added

- Terminals now render on the GPU. The pane on screen uses the WebGL renderer instead of building
  one DOM element per cell, which is what made scrolling crawl in a workspace with several open
  sessions. The context follows visibility, so hidden panes release it and only what is on screen
  holds one. Where the WebView has no usable WebGL — WebKitGTK ships it off on some Linux builds —
  the pane now falls back to the 2D canvas renderer instead of straight to the DOM, and the tier it
  landed on is recorded in `app-events.log` as `terminal.renderer`.
- **Smart LRU** now does something. When the workspace is over its memory budget and hidden
  sessions have been idle past their threshold, Arco offers to park them in a notification with a
  **Park** action. Nothing is parked until you choose it, parking frees the whole process subtree,
  and the scrollback and session identity survive so the agent resumes where it stopped. Visible,
  focused, working and recently spawned runtimes are never offered.

- **Command parity across the app.** Terminals, workspace persistence, profiles (create, rename,
  delete, switch, with real project and terminal counts), CLI discovery, session listing, window
  controls, dialogs and the file sidebar; git (status, staging, diffs, branches, worktree listing),
  MCP configuration and health probing, the clipboard, Claude and Codex quota, per-session and
  per-transcript cost, activity stats, the agent library, backup and restore, agent worktrees,
  project stack detection, the agent hook listener that drives live status, dictation with the
  on-device model, the planning gate and its GSD side-channel, planning audit commits, the task
  scheduler, validation runs, provider handoffs, the skill catalog for every agent, plugins, graph
  snapshots with diff and rollback, the `arco` CLI shim, GitHub gist sync, the Codex app server
  bridge, the resource sampler that drives Smart LRU (per-terminal memory and CPU read from the
  process tree), window opacity, native dialogs and notifications, and the pending path a
  `arco <dir>` launch hands to the running window.

- A task can now start the agent session that works on it. The **Start session** action on a task row
  opens a launcher preloaded with the target project, agent, folder, worktree isolation and a first
  message built from the task title, tags and notes. The new pane is named after the task, focused
  right away, and linked back to the task.
- Tasks record the sessions they launched. The task row shows a live badge with how many linked panes
  exist and whether any of them is working, the expanded task lists each session with its agent, state
  and age, one click jumps to that pane, and a session can be unlinked once it is no longer relevant.
  Closing a pane, deleting its project, or deleting a group with its projects unlinks the affected
  sessions automatically. The sidebar header shows how many tasks have a session working right now.
- Tasks gained priority (high / normal / low), free-form notes and creation/completion timestamps.
  Priority shows as a marker on the row and floats a task up inside its section; notes travel into the
  session prompt. Expanding a task reveals notes, priority, project and session history inline —
  clicking the title now expands the task instead of editing it, and the pencil action still renames.
- The Todo sidebar can be filtered by tag, with the chips ordered by how many tasks use each tag.
- Claude Code and Codex conversations can now be continued in the other agent from the terminal
  toolbar or Recent chats. Alethe builds an editable, locally redacted context packet, opens the
  target agent in a new pane, keeps the source conversation available, and removes the temporary
  packet after the first target turn or when its pane is closed.
- The right sidebar now keeps a cumulative, per-profile history of up to 12 recently opened
  Markdown files as switchable tabs, persisted across app launches. Markdown files can be sent
  there from the Explorer or dropped from the desktop, history tabs can be closed individually,
  and they remain available while visiting the Todos, Git, or MCP sidebar modes.
- GitHub Copilot CLI is now available as an agent throughout onboarding, installation, quick launch,
  terminal creation, sub-tabs, CLI path overrides and unrestricted mode.
- New **Golden Premium** theme, with its own terminal palette.
- New **MCP** tab in the right sidebar: a single place to see every MCP server configured on the
  machine, grouped by server name and showing which agents have it. It reads Claude Code
  (`~/.claude.json`, `.mcp.json`), Codex (`~/.codex/config.toml`), OpenCode (`opencode.json`) and
  Antigravity (`~/.gemini/config/mcp_config.json`), with a Global/Project switch — so a server
  present in Claude but missing in Codex is visible at a glance. At project scope it also reads the
  servers `claude mcp add` writes by default, which Claude keeps inside `~/.claude.json` under the
  project's entry rather than in the repo, and labels each row with the file it came from. Environment values are masked and
  only leave the backend one key at a time, on an explicit click. A config that cannot be parsed is
  reported as read-only and is never written to. Servers can be added, removed and enabled/disabled;
  every write is preceded by a backup, validated by re-parsing the result and checking that no other
  server changed, and committed atomically. A server can be **copied from one agent to another** in
  one click, and adding a new one takes a form, a pasted JSON block in any of the shapes the agents'
  own docs use, or a search of the official MCP registry — which turns a published package into a
  ready-to-run command and pre-fills the variables it expects, marking the secret ones empty. The
  last successful search of each term is kept on disk so the list still opens when the registry is
  unreachable, labelled with the date it was captured. Alethe translates a server to each target's
  format and refuses, rather than silently dropping, a field the target cannot express. A per-agent
  **Check** button asks the agent itself whether it can actually reach each server — the one thing no
  config file can answer. The first time the app opens with the feature on, a card shows what was
  found and offers to align the agents in one click; it can be reopened at any time from
  Preferences → Features, where the whole feature can also be turned off.
- The MCP tab splits into **Servers** and **Skills**, each with its own search and an **Add more**
  button that opens the manager straight on the registry search. Every row shows the icon of each
  agent that has the entry, greyed out for the ones missing it, and a row of agent buttons filters
  the list down to a single agent. A server or a skill can be removed from every agent at once
  instead of one row at a time, and the add flow asks which agents get it before writing anything.
  The registry search filters by whether a server runs locally or remotely.
- A **Skills** tab in the same manager lists every skill installed for each agent, reading
  `~/.claude/skills`, `~/.codex/skills` and the shared `~/.agents/skills` store. It resolves links
  (including Windows junctions) so a skill shared between agents is shown once with its real
  location, renders the SKILL.md frontmatter, folder structure and body, and surfaces where the
  skill was installed from. Skills that ship with the agent are locked and cannot be deleted;
  removing a linked skill unlinks it from that agent only and keeps the shared copy the other
  agents point at.
- The sidebar's **Organization** block is back to the 1.5.0 layout: the label with the four layout
  modes, plus the workspace grid button — the reworked panel with stacked icon rows and a scope
  switch in its header was reverted.
- The right sidebar no longer depends on the Todos feature being enabled — it now appears whenever
  Todos, MCP, or Git-on-the-right is active.
- Grid layouts are now edited directly on the grid. Every pane and every project container carries
  resize edges: dragging against a neighbour resizes the tracks as before, but dragging towards an
  empty cell stretches the pane over it, cell by cell. Double-clicking an edge — or the expand button
  that appears on a pane with empty space next to it — makes that pane swallow all the free space
  around it, so a lone pane on the bottom row can finally take the whole row without opening a
  dialog. Empty cells also became drop targets: dragging a pane or a container onto one moves it
  there instead of swapping with a neighbour.
- The project container header has a **+** button that creates a new terminal in that project.
- Agents that are not installed can now be installed from inside Alethe. The onboarding agent step
  and the "not found" overlay of a terminal both offer an **Install** button that runs the official
  installer in a real shell and streams its output, then confirms the CLI is reachable before
  reporting success. Alethe probes the machine for Node, npm, WinGet, Scoop and Chocolatey and only
  offers the methods that work there, preferring each vendor's official installer — which needs no
  Node — and listing the alternatives under **Other ways**.
- A **Recent chats** button on the terminal toolbar, next to Open in VS Code, lists the Claude and
  Codex conversations of that pane's working directory and resumes any of them, either in a new pane
  on the current grid or in the pane it was opened from. The panel opens on the tab matching the
  pane's agent, and unrestricted mode is a checkbox applied to the resumed session.
- **Ctrl+B** toggles the left sidebar open and closed. The topbar button now shows the shortcut in
  its tooltip.
- Installing an agent now happens in a dialog. It lists every method that works on this machine —
  the vendor's own installer, npm, WinGet, Scoop, Chocolatey — with the exact command each one runs,
  and you pick which to use instead of being given one button and a hidden "other ways" list.
- When an agent can only be installed through npm and Node.js is missing, its install dialog now says
  so instead of dead-ending on "no automatic installer". It offers a one-click Node.js install
  through WinGet, Scoop or Chocolatey when one of them is available, and a **Download Node.js**
  button otherwise. Once Node lands, the agent's own installer appears without reopening the card.
- Freebuff and Mimo can now be installed from inside Alethe like the other agents, with their
  documentation links — until now they were the only agents with no installer at all.
- Installed agents can be **uninstalled** from the onboarding agent step. Confirmation happens in a
  dialog that shows the exact command about to run, and the agent is only reported as removed once
  its CLI can no longer be found. Only one agent can be installed, updated or uninstalled at a time —
  package managers share a single global directory and corrupt each other when run in parallel.
  Agents whose only installer is a vendor script offer no uninstall, since none of them documents
  one and guessing what to delete
  would be worse than doing nothing.
- The onboarding agent step was rebuilt as a table. Every agent is one row with its icon, the
  resolved path of its CLI, the installed version, a status tag, and its actions — install, update
  or uninstall — so all rows line up regardless of what each agent offers. Above it there is a
  counter strip (enabled, up to date, with updates, installable), a search field that matches on name
  or path, and All / Detected / Installable filters. A **Scan again** link re-runs detection without
  leaving the step, for when an agent was installed outside Alethe.
- Agents with a newer release published on npm can be updated in place from that table.
- Right-clicking a terminal pane pastes the clipboard (text, images and files) when nothing is
  selected; with a selection, the right click copies it and clears the highlight.

### Changed

- **Arco now runs on Chromium.** The interface moved off the system WebView (WebKitGTK on Linux,
  WebView2 on Windows) onto Electron, which is what the app ships and what `npm run app` starts.
  Typing, scrolling and rendering in the terminals are visibly faster; the WebView was the ceiling
  the previous release kept hitting. The frontend is unchanged — it still calls `invoke()` and
  listens to `pty://data/{id}` — and the workspace, profiles, scrollback and settings on disk are
  the same files, so an existing installation carries over untouched. The previous Rust/Tauri shell
  stays in `src-tauri/` as legacy and is no longer built or released.
- Packaging is now `npm run package`, producing an AppImage in `dist-electron/`. The machine that
  runs it needs Node installed: the terminal and speech hosts run under the system Node, because
  their native bindings target Node's ABI.

- A workspace tab now shows a single project, always. Creating a terminal or opening a pane in
  another project switches to that project's tab instead of adding it to the tab you are on, so
  panes of two projects can no longer end up mixed on the same screen. Opening a group now opens one
  tab per project of the group; those tabs sit together in the tab bar under a chip with the group
  name and color, and clicking the chip closes them all. The tab limit went from 10 to 20 to make
  room for groups.

- The memory sampler got substantially cheaper. It no longer collects per-process disk usage it
  never displayed, measures each process's private memory once per cycle instead of twice, reuses
  its process table across sweeps, and slows from 5s to 30s while no window is on screen. Saving
  the PTY root list — which runs on every spawn and every close — no longer sweeps every process on
  the machine to read a handful of them.

- GitHub Copilot is drawn with its official mark instead of the generic robot placeholder, so every
  agent in the app now carries its own logo.
- Setting MCP up is no longer a step of first-run onboarding. It is offered once as its own card
  after the app opens, and stays available in Preferences → Features — onboarding goes back to five
  steps.
- The layout designer dialog now uses the same drag-and-drop engine as the rest of the app. Cards
  follow the cursor without lag, only the cell under the pointer lights up, a plain click still just
  selects, and cards are resized with the same edge handles as the real grid.
- Switching workspace tabs no longer reloads them. Every tab in the tab bar — the same ones Ctrl+Tab
  cycles through — stays mounted in the background instead of being torn down, so its terminals keep
  their scrollback, their PTY attachment and their scroll position. Coming back to a tab no longer
  shows a boot spinner and never restarts anything, however many projects you move between. The two
  most recently used background tabs also keep receiving output, so returning to them costs nothing
  at all; the rest pause their stream while hidden and redraw on return. None of them are suspended
  for being idle while they stay mounted. A tab that produced no output while it was away skips the
  redraw entirely and comes back untouched.

- **Remote control is now off by default and stays off until you turn it on.** Alethe used to open a
  LAN listener on every launch, and the on/off switch was lost when the app restarted. The setting is
  now saved with your preferences and the listener only starts while it is enabled.
- The remote pairing address and QR code are only shown while a pairing window is open, and the
  address the phone uses is no longer carried in the page URL after pairing.

- High-volume terminal output now coalesces runtime activity timestamps, avoiding repeated global
  state updates and skips remote-control serialization when no remote device is connected, without
  delaying terminal rendering or process I/O.
- Spotify playback widgets now share connection and track requests instead of polling the backend
  independently.
- The title bar now uses a lightweight connected-device count and pauses remote-control polling while
  the app is inactive, avoiding repeated QR-code generation for a badge update.
- Native browser panes now share one overlay observer instead of each watching the entire application
  DOM independently.
- Remote-control polling now reuses the pairing QR code until its URL or token changes.
- GSD session watching now reads child state in one background command instead of launching three Git
  root-resolution processes per watched item every five seconds.
- Layout editing now provides a smoother drag preview, a clearer preset/history library, and reduced-
  motion support. Sidebar activity indicators now share the trailing action slot with the three-dot
  menu, while Todo edit and delete actions no longer reserve empty space before hover or keyboard focus.
- Repository instructions now explicitly require English for source comments, JSDoc, internal logs,
  documentation, changelog entries, and default user-facing strings.
- Windows installers now include the official WebView2 bootstrapper and automatically install the
  Evergreen Runtime when it is missing, instead of downloading the bootstrapper separately.
- App icon choices now update the running native window and taskbar icon immediately.
- The corrected Windows installer now identifies itself as 1.5.1 so it reliably upgrades existing
  1.5.0 installations instead of entering same-version maintenance mode.
- Memory monitoring no longer parks runtimes, closes tabs, or blocks new sessions automatically.
  Memory Analytics now bases its health alert on available Windows memory and keeps session closure
  under explicit user control.
- Sidebar visibility and widths now change only after explicit user input, so startup and automatic
  layout adjustments cannot close a sidebar or overwrite its saved size; pending workspace changes
  are also flushed before the native window closes.
- Resource health is recorded periodically in `logs/resource.log`, and failed `projects.json` saves
  are logged and retried instead of being silently discarded.
- Everything inside a group now sits indented under a barely-there rail that picks up the group's
  color on hover, so a grouped project is distinguishable from a loose one without adding noise.
- Groups and projects now expand and collapse with a short height-and-fade animation, and the
  disclosure chevron rotates instead of swapping icons. Both respect reduced-motion.
- Group headers now read as section labels — quiet 11px text and a rule line, with no folder mark —
  so they are no longer mistaken for project rows, and project and session rows were tightened to a
  28px scale so the group no longer competes with them.
- Reworked both sidebar styles into a flat three-level list. Groups are now section dividers (label,
  rule, add and collapse actions) instead of a tree level, every project renders as a single folder
  row with its sessions underneath, and the boxed active-project card, its primary badge and its
  separate new-terminal button are gone — the row's + creates a session and clicking a group header
  only expands or collapses it.
- Row actions (+ and the three-dot menu) now appear on hover, and the selected session is marked
  only by a solid background.
- Hidden and paused agents are now signalled only by a desaturated agent logo and a softer name —
  the strikethrough and the italic "disabled" styling are gone.
- The agent logo is now the leading element of every terminal row; the running indicator and the
  response-ready badge moved to the right end of the row.
- Standardized the entire changelog in English and made English the explicit default language for
  versioned repository content and commit messages.
- Added Normal and Clean application-wide visual styles. Normal preserves the production UI with
  colored borders and rounded surfaces, while Clean uses the new compact project tree, flat right
  sidebar, square terminal containers, restrained hover states, and single-row profile footer.
- Added shared Clean visual tokens for row and control heights, spacing, radii, borders, hover
  surfaces, and transition behavior so the minimal language can be extended consistently.
- Simplified Clean sidebar selection with subtle background feedback and no side markers, preserved
  animated running-state indicators, removed the Ungrouped heading and Primary badge, increased tree
  spacing, and added a direct new-terminal action to every project.
- The Clean sidebar footer now keeps the latest known Spotify track visible when playback is
  inactive and stays hidden when no real track is available, without an empty connection prompt.
- Clean mode now presents a dedicated New Agent action, folder-based project rows, one focused row at
  a time, dimmed inactive agent icons, and matching flat selection feedback in the top bar.
- Extended Clean styling across dialogs, dropdowns, context menus, workspace panes, browser/video/
  Markdown surfaces, sub-tabs, Home cards, empty states, and floating inspectors with neutral focus,
  flat hover feedback, reduced motion, and no heavy elevation shadows.
- Tightened the Clean sidebar tree: New Agent moved below the toolbar and reads as a quiet row,
  project rows dropped the branch label, agent counter and standalone AI icon, every project now
  expands by default with its own chevron, and group, project and terminal rows were reduced in
  height with clearer indentation between the three levels.
- Removed finished-agent badges from Clean sidebar items while preserving the aligned state gutter
  and animated working indicator for agents that are actively running.
- Removed the workspace's animated gradient focus frame in both visual styles, increased the Clean
  sidebar's separation between groups and projects, and added group logo selection to both group
  creation and editing with a folder fallback.
- Removed the space-consuming terminal header bar in both visual styles and kept its controls
  available in a compact hover overlay that does not reduce terminal content height. The overlay
  now also shows the active conversation's agent logo and name on the left.
- Spotify now refreshes existing connections automatically and falls back to the most recently
  played track when nothing is currently active, while connection prompts no longer appear in the
  sidebar or Home dock.
- Increased inactive Clean top-bar tab and logo contrast, aligned Spotify and profile footer rows to
  the same proportions, and restyled the profile menu with the shared compact Clean popover metrics.
- Matched the Clean right sidebar to the left sidebar's flat toolbar, controls, spacing, and list
  treatment, and standardized every Clean menu and dropdown on the profile menu's smooth entrance
  motion, including model, project, agent-usage, context, Home, and terminal-link selectors.
- Project and group rows now prefer their configured logo over the folder fallback in Clean mode,
  and the right sidebar mirrors the left toolbar's button sizing, spacing, utilities, and active states.
- Claude rows in both sidebar styles now show the live conversation title, falling back to the first
  user prompt and then the agent name, with long titles truncated without disturbing row actions.
- Groups are always ordered above loose projects at every sidebar level, orphaned subgroups remain
  visible at the root, and configurable group logos replace the folder fallback in both styles.
- The Clean Organization layout strip now matches the 40 px footer rhythm with compact, flat controls.
- Extended Clean mode to the remaining top-bar controls: flat icon buttons without scale-on-hover,
  borderless usage, RAM, profile and sync pills, and a lighter usage popover.
- The onboarding now asks which interface style to use (Normal or Clean) with a live preview of each
  one, right after the theme step.
- Removed the optional GitHub repository clone field from the new-project dialog.
- Removed Merge Center from both project-sidebar visual styles.
- Restored browser panes in the workspace grid. **Add browser** is available from the app menu
  and each project's three-dot menu, opens a dedicated URL and settings dialog, and runs every
  page in a native incognito webview whose cookies, cache, autofill, and site storage are discarded
  when the pane closes.
- Added a live Remote Control device counter to the top bar with direct access to the connection
  panel.
- Removed the Infinite Rainbow project-color option, its animated styles, and its workspace focus
  treatment. Existing invalid or retired accent values now fall back to a stable solid color.

### Removed

- **Spotify, Discord presence and remote control** are not part of this release. They existed only
  in the previous shell and were not carried over.

- Everything that only existed to arrange several projects on one screen: flat mode, the workspace
  grid designer, the group grid designer, dragging one project container over another, and the
  "Add to current view" action for projects, groups, terminals, and saved tabs. The grid designer
  remains for the panes of a project. Existing files are migrated: a tab that held several projects
  becomes one tab per project, keeping pins and history.

- The Merge Center is gone: its sidebar panel, the **Merge** tab of the project editor, the branch
  testing dialog, the merge store, and the `merge_analyze` / `merge_prepare` / `merge_finalize` /
  `merge_abort` / `merge_preflight_abort` / `merge_rebase_onto_target` / `merge_force_cleanup`
  backend commands, along with the `merge_analyzer` and `conflict_resolution` modules behind them.
  Projects no longer carry a post-merge action setting. Worktrees, the conflict-resolution agent
  settings and GSD Sync are untouched — they only shared the `merge.` prefix.

### Fixed

- The last line of a terminal is no longer cut off at the bottom edge. The fitted row count could
  land one row past what the pane can actually show, which pushed the prompt — the line an agent
  writes to — below the fold. The extra row is now given back when the rendered screen overflows
  its pane.
- A confirmation dialog now really asks. It answered "yes" without showing
  anything, so a destructive confirmation went through untouched.
- Panes no longer sit on "Preparing terminal…" when a step of the boot stalls. Session discovery,
  CLI probing and graph indexing each get five seconds, spawning gets thirty, and the terminal is
  opened as soon as its container has a size rather than waiting for an animation frame that a
  hidden window never delivers. Graph indexing also stopped blocking the boot: on a large repository
  it held the pane for minutes.

- The Claude Code usage tooltip in the title bar no longer shows `NaNm` as the reset time. When the
  API reports no reset timestamp for a window, the tooltip now shows `—`, and an already-elapsed
  window shows the translated "resetting…" label instead of untranslated English.
- A pane no longer opens its terminal into a container the browser has not laid out yet, which left
  xterm's render service without dimensions and threw on the first scroll sync. The GPU renderer is
  attached on the same condition.
- Terminals now use a font the machine actually has. The stack named Windows fonts only, so on
  Linux every cell fell back to the generic `monospace` and every glyph an agent TUI draws — the
  braille spinner, box drawing, Nerd Font icons — went through font fallback and a fresh texture
  upload into the renderer's glyph atlas on each repaint. The pane now picks the first installed
  family from a per-platform list.
- The build no longer ships a stale frontend. `cargo build` had no idea the compiled bundle in
  `dist/` was an input, so a frontend-only change produced a successful build that kept the previous
  UI inside the binary.
- A workspace of running agents no longer saturates the renderer. Each pane repainted on every
  animation frame, which on a 144 Hz display meant 144 repaints a second per pane — measured on a
  four-agent workspace, that alone pinned a CPU core and made typing, scrolling and dictation lag
  everywhere in the app. Panes now repaint at most 30 times a second, and 20 for panes that are on
  screen without the focus; the same workspace went from a saturated core to about a third of one.
  Output that answers a keystroke keeps bypassing every ceiling, so the echo is still immediate.
- Typing in a terminal feels immediate again. A keystroke no longer waits out the backend's output
  coalescing window nor an animation frame before its echo reaches the screen, and the pane stopped
  flushing layout twice per character. Bulk output still batches as before.
- Idle CPU dropped sharply. Memory sampling scanned every process — and on Linux every thread of
  every process — three times every few seconds, once through a quadratic subtree walk; the samplers
  now share one scan, and between full scans only the app's own subtree is refreshed. A pane also no
  longer rerenders four times a second while an agent streams output.
- Terminals no longer inherit the AppImage's own runtime environment (Linux). `PYTHONHOME` and
  `PYTHONPATH` pointed inside the AppImage mount, so every `python3` a session ran died with
  "Failed to import encodings module" — which broke agent hooks written in Python. `LD_LIBRARY_PATH`,
  `PATH`, `PERLLIB`, `XDG_DATA_DIRS` and the GTK/Qt/GStreamer variables leaked the same way and
  could make a spawned binary load the bundle's libraries instead of the system's.
- The **Memory monitoring** preference was never sent to the backend — the choice between
  **Smart LRU** and **Monitor only** was ignored and the app always behaved as **Monitor only**.

- Deleting a group together with its projects no longer leaves tasks pointing at a project that is
  gone — those tasks now fall back to the unassigned section instead of disappearing from the list.
- The topbar widgets no longer jump sideways when you hover them. The pencil button that opens the
  widget settings used to expand from zero width on hover, pushing every pill 26px to the left —
  enough for the pill you were reaching for to slide out from under the cursor, which dropped the
  hover, collapsed the button and shifted everything back, flickering in place. Its slot is now
  reserved at all times and only the button itself fades in.
- An extensionless path in terminal output no longer swallows the rest of the sentence as a link:
  `/pt-br/vitrine-dupla/trajetoria — 5 variações` used to underline the whole line. A space now ends
  the link unless a file extension is waiting on the other side, which is what a path with spaces
  actually looks like.
- Invalid CLI overrides are rejected instead of being saved and launched. Existing invalid overrides
  are cleared automatically, preventing the Antigravity desktop application from opening when Alethe
  expects the `agy` command-line executable.
- The agent update button in onboarding no longer fails silently. It decided success purely by
  checking whether the CLI binary was still on PATH, which is true even when the update itself
  failed (network error, permission denied, ...), since the previous binary is still there. The
  installer's real exit code is now checked first, and a failed update shows a toast instead of
  quietly leaving the CLI on its old version. It also now catches the case where the installer
  genuinely succeeds but a second, unmanaged install of the same CLI earlier on PATH shadows the
  one that was just updated: if the resolved binary's version hasn't moved, the update is reported
  as failed and the toast names the shadowing binary's path instead of reporting a false success.
- Antigravity no longer shows "Version unknown" forever in onboarding. Latest-version lookup only
  ever checked the npm registry, and Antigravity ships through a native installer instead of npm,
  so it never had a package to look up. It now falls back to the latest tag on its public GitHub
  releases when an agent has no npm package.
- A terminal that accepted keystrokes but rendered nothing — recoverable only by restarting it — now
  recovers on its own. Output is gated per PTY by a visibility flag, and the call that switches it
  back on was silently ignored whenever it landed while the session was spawning or restarting,
  leaving the stream off with nothing to turn it back on. The resource sampler now re-asserts
  visibility for every PTY on each pass, so a stuck stream clears within one sample instead of
  lasting until the terminal is restarted.
- Terminals start faster. Resolving an agent's launcher scanned every directory in PATH on every
  boot; successful lookups are now remembered and revalidated against the file itself, so installing
  or removing a CLI is still picked up immediately.
- An agent pane no longer loses the conversation it was resuming when you leave and come back to it
  quickly. The saved session was being read destructively at launch, so a pane torn down mid-launch —
  switching workspace tabs with Ctrl+Tab, for example — erased the only record of its conversation and
  came back on a different chat. The record now survives until a new session actually replaces it.
- The terminal "command not found" overlay was written in English regardless of the selected
  language; its text now goes through the translation system like the rest of the app.
- A pane no longer starts an empty chat when you come back to it after a long time away. The session
  claim that prevents two panes from writing to the same conversation was tied to the PTY id, so a
  PTY that ended on its own — parked by memory control, suspended, or killed — left the conversation
  permanently marked as taken and the pane silently dropped its own session id.
- Reopening a pane no longer replays its history line by line. The stored scrollback was fed to the
  terminal in 16 KB slices, one rendered frame each, so a large buffer visibly scrolled from the top
  down to the prompt and took seconds; it is now written in a single pass straight to the bottom.
- Switching conversation from inside the CLI with `/new` or `/resume` now sticks. Alethe pinned the
  session id given at launch and sent the old one back on the next restart, dragging the pane to the
  previous chat.
- Ctrl+Tab did nothing after coming back to the app from another window. Returning left the webview
  with no focused element, and WebView2 then kept the key for its own focus traversal instead of
  handing it to the app. Focus is now parked on the app shell whenever nothing else holds it, so
  every shortcut keeps working. Ctrl+Tab also focuses the first terminal of the tab it switches to,
  instead of switching with the keyboard pointed at nothing.
- Agent CLIs installed through Homebrew were invisible on macOS. An `.app` launched from Finder does
  not run as a login shell, so it inherits the minimal Launch Services PATH without `.zshrc` /
  `.zprofile`. Launcher discovery and the PATH rebuilt for terminals now include the default Homebrew
  prefixes (`/opt/homebrew/bin` and `sbin` on Apple Silicon, `/usr/local/bin` and `sbin` on Intel) as
  a fixed fallback.
- The Antigravity usage widget showed "—" on Linux. The OAuth token lookup used an explicit keyring
  target required by the Windows Credential Manager, which prevented the Linux Secret Service (GNOME
  Keyring / KWallet) from finding the entry written by the `agy` CLI. Credential discovery now
  supports both layouts and also looks for the `agy` binary in `~/.local/bin` and `~/.cargo/bin` on
  Linux and macOS.
- Pasting an image or files into a terminal did nothing on Linux, silently. `read_clipboard_payload`
  was implemented on Windows only and errored out everywhere else without falling back. A Linux/BSD
  backend using `wl-paste` / `wl-copy` (Wayland) or `xclip` (X11) now handles screenshots, images
  copied from the web (`image/png`) and files copied in a file manager (`text/uri-list`). macOS is
  still unimplemented.

- The Files sidebar now supports quick previews, adding or dragging files into the workspace grid,
  revealing entries in File Explorer, renaming, and confirmed deletion. Git file rows can also open
  the working file in the grid or reveal it alongside the existing stage, discard, commit, and sync actions.
- Browser panes now offer app-first, balanced, and keep-alive resource modes. App-first is the default,
  and every mode releases hidden native webviews when Alethe detects memory pressure.
- The layout organizer now includes adaptive presets and keeps the eight most recently saved layouts
  separately for each project, group, and workspace.
- New **Ember** interface theme: cool charcoal surfaces, hairline dividers and a single ember-orange
  accent for live state, with a matching terminal palette. Selectable in Preferences → Appearance and
  as the terminal theme; it does not ship a native app icon variant.
- Remote control now pairs through a **short-lived pairing window**. The QR code is valid for two
  minutes and stops working as soon as one device pairs; a paired device receives its own session
  token and can be revoked individually. Preferences → Remote control can reopen or close the window
  at any time.
- A message sent from a paired phone now raises a desktop notification naming the device and showing
  what it sent, so remote input is never silently typed into a terminal.
- Individual terminals can now be hidden from remote devices from the sidebar context menu. A hidden
  terminal disappears from the phone's list and its output and input are refused server-side.
- Remote control gained a **read-only mode** (on by default) and a separate switch that decides
  whether plain shell terminals accept remote input. With both at their defaults a paired phone can
  watch terminals but cannot type into them.

- Remote control session lifetime, the device limit, and per-device revocation now apply to the whole
  remote surface. They previously only guarded the live WebSocket, so an expired or revoked device
  could still read terminal output and send messages over HTTP.
- A paired phone now only receives output from the terminal it is watching. Every terminal's output
  was previously broadcast to every connected device.
- The remote workspace listing now sends only the fields the phone renders, instead of copying raw
  workspace records.
- Remote requests split across network packets are no longer truncated, oversized requests are
  rejected, and a failed request always gets a response instead of leaving the phone waiting.
- Remote connections now time out, are capped in number, must authenticate within ten seconds, and
  repeated bad tokens temporarily block the offending address — a device on the same network can no
  longer exhaust the app's connections.
- Remote control now re-reads the machine's network address every time it is enabled, so the pairing
  QR code stays valid after switching Wi-Fi networks.

- The **App icon** setting in Preferences → Appearance now actually changes the taskbar and window
  icon. It previously sent the bundled asset URL to the native window, which silently failed, so the
  icon never left the default variant. Each icon now ships at 32, 48, and 64 pixels and the variant
  matching the display scaling is used, so the taskbar no longer shows a blurry downscale.
- Critical Windows memory pressure now suspends one eligible hidden idle runtime at a time, preserving
  session scrollback while preventing system-wide stalls that can make even Alt+Tab stop responding.
- Submitting `/new` in an agent terminal now clears both the visible conversation and its persisted
  terminal scrollback, so the fresh session no longer inherits the previous conversation on screen.
- Terminals now recover automatically when a native PTY write stalls instead of blocking every
  later keystroke until a manual refresh, and use the stable xterm DOM renderer to avoid a renderer
  transition race that could leave the terminal unable to accept input.
- Large terminal pastes now use bounded high-throughput IPC chunks, preserve Unicode boundaries, share
  the normal input queue, skip synchronous per-character prompt-history work, and always close
  bracketed-paste mode after partial failures. This prevents Claude Code and Codex pastes from freezing
  the app, interleaving with typing, or stopping halfway.
- Native browser panes now remain hidden for the full lifetime of modal and menu overlays, including
  closing animations, preventing them from flashing above or interfering with dialogs.
- Opening a terminal's tabs lane now moves only its left floating identity to the right, while the
  existing right-side actions remain anchored in place. The pane drag handle moves into the lane,
  directly above its tab items, so it no longer covers terminal content.
- Fixed the freezes and runaway memory growth introduced with the new sidebar. The conversation
  title shown on each session row was rescanning and fully parsing every Claude session file of the
  project — up to hundreds of MB — every 12 seconds, on the thread that serves the whole UI. Rows
  now read only their own session file, off the main thread, and stop once the title is known.
- Session scans no longer load a whole record into memory, so a single oversized message can no
  longer abort the app with an out-of-memory error and take every open terminal down with it.
- Session scans that take longer than 250 ms are now recorded in `logs/app-events.log`.
- Closing the app no longer crashes or becomes unresponsive mid-shutdown. Process-tree cleanup now
  runs outside the native event loop, while a frontend deadline destroys the window if the native
  quit request does not settle, so slow Windows process termination cannot hold the interface open.

- Prevented private browser panes from failing to start when development-mode effect remounts
  briefly overlap while a previous native webview is closing.
- Fixed the Git initialization button contrast across accent colors by using the theme's matching
  foreground token.
- Fixed project-name overflow so long paths use a clean ellipsis without colliding with status
  badges in either visual style.
- Fixed backup imports by excluding locked WebView runtime caches, ignoring those entries in legacy
  archives, validating the archive before deleting local data, and closing active terminals before
  restoration.
- Clean sidebar group headers now only expand or collapse the tree instead of also adding every
  project in the group to the workspace.
- GitHub repository cloning no longer depends on a hardcoded `D:\Projects` directory. The selected
  destination is now respected, with `~/Alethe/<repository>` as the cross-platform fallback.
- Removed the unused WebGL terminal rendering path and dependency. Terminals continue to use the
  Canvas 2D renderer without a behavior change.
- Background agents now report completion through the lightweight off-screen activity channel.
- Lightweight background output is accumulated between updates instead of being discarded, so
  activity detection and Codex busy-session recovery remain reliable off screen.
- Output written while an agent pane restores its history is replayed after the restore instead of
  leaving a permanent gap.
- Remote Control no longer drops accented characters when a UTF-8 sequence crosses a buffer cut.
- Visible-pane calculations now run once per state update and are shared instead of running once per
  open pane.
- Memory-pressure spawn blocking now queues every new request. The reduced concurrency ceiling only
  controls how many existing waiters may be released.
- Synchronized the bundled GSD plugin version with its actual v11 content so older worktrees receive
  automatic updates.
- Main terminals can no longer claim a GSD child conversation merely because GSD monitoring was
  disabled after its sentinel file had been created.
- New GSD plugin instances clear stale synchronization markers left by crashed or closed processes.
- Terminal hover and click coordinates are remeasured after app zoom changes, keeping xterm.js link
  detection aligned with the pointer.
- Development builds on Linux now also apply the Alethe icon at runtime. Packaged builds remain the
  reliable icon source for compositors that prefer desktop-file lookup.
- Linux now sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` before creating the webview, avoiding the known
  WebKitGTK DMA-BUF animation and fractional-scaling issues documented by Tauri.
- Linux animations now prefer compositable properties and avoid `transition: all` and animated width.
- GSD child sessions are read-only across xterm input, paste, prompt history, and force-kill shortcuts.
- OpenCode no longer emits unsupported OSC 66 width queries in xterm.js because spawns set the
  documented `OPENTUI_FORCE_EXPLICIT_WIDTH=false` compatibility flag.
- OpenCode redraw nudges after spawn and resize now share a 400 ms lock, preventing overlapping TUI
  redraws.
- The `windowsPty` xterm.js option is now enabled only on Windows, fixing dense TUI redraws on Linux
  and macOS.
- Scrollback resynchronization now cuts only at valid UTF-8 character boundaries.
- Conflict-resolution model selections are no longer overwritten by background project updates while
  the edit dialog is open.
- The full project form now inherits a folder selected on the empty-workspace screen, and truncated
  paths expose their complete value on hover.
- Git initialization and refresh actions use consistent full-width stacking in narrow sidebars.
- The project editor now warns when its folder is not a Git repository and offers initialization
  without leaving the dialog.
- Windows orphan-process cleanup now logs Job Object failures, records root processes, and cleans
  verified leftovers after an unclean shutdown.
- Merge diff summaries and test briefings now include uncommitted worktree changes, not only commits
  between branches.
- GSD Sync sessions now appear in Tasks for OpenCode terminals even when worktree isolation is off.
- GSD test procedures include files committed on the current worktree since it diverged from
  `main` or `master`.
- Provider model search no longer pollutes another provider's cache during rapid switching, preserves
  one selection per provider, and accepts custom searched models with Enter.
- Off-screen agent terminals no longer render full output continuously. They receive lightweight
  activity updates and restore complete scrollback immediately when shown, without pausing agents.
- Off-screen terminal history loading is deferred until the pane becomes visible, and heavy TUI
  writes are processed in 16 KB chunks instead of 64 KB chunks.
- Migrating existing terminals now restarts each live pane in its new worktree instead of leaving the
  visible process in the old directory.
- Worktree migration now reinstalls GSD monitoring and uses the latest unsaved project configuration.
- Enabling GSD monitoring creates a missing `.planning/` directory instead of failing silently.
- The **Open folder as project** button now uses a visible text color in every theme.
- Terminal hover links now support mixed-case protocols such as `Https://` and bare deployment
  domains such as `example.vercel.app`, while excluding file names and email addresses.
- Workspace panel sizes now persist per profile and workspace screen for outer project containers and
  nested terminal splits in Auto, Spotlight, and Sidebar layouts.
- Sidebar drag-and-drop now keeps list geometry stable, separates reordering from group nesting, and
  uses theme-native insertion lines and subtle neutral targets.

## [1.5.0] — 2026-08-09

### Added

- Added authenticated LAN Remote Control for browsing agent chats, watching live output, and sending
  one message at a time from a mobile browser.
- Added Remote Control enable and disable controls, device limits, token regeneration, named devices,
  session metadata, one-hour default expiry, and individual revocation.
- Added Agent Sandbox job and thread identifiers, structured spawn acknowledgements, persistent Codex
  app-server threads, parent-to-worker relationships, and reply relay back to the Claude planner.
- Added persistent Agent Sandbox projects with project folders, live session restoration, project
  switching, on-demand workers, and regular project terminal synchronization.
- Added regular shell workers to Agent Sandbox so long-running development servers remain visible as
  plain terminal panes.
- Added development and installer icon themes independent from the interface theme.
- Added **Erase all data (fresh install)** after backup export for a complete local reset.

### Changed

- CLI detection during onboarding is time-boxed per provider so slow PATH entries cannot freeze setup.
- New profiles reach onboarding cleanly, and parking terminals no longer blocks account switching.
- The default profile image and generated app icons now use the dark Alethe artwork.
- Agent Sandbox project creation entry points are hidden behind a build flag while the feature is
  archived.
- The startup screen now shares the Home background and ASCII-art treatment.
- Profile export now includes the complete profile, including Todos, history, metrics, preferences,
  tokens, scrollback, and all other stored data.
- Account switching closes each pseudoconsole before waiting for its final scrollback flush and can
  resume parked sessions without restarting the app.
- The Accounts modal has clearer hierarchy, spacing, and profile creation controls.
- Project dropdowns use the Todo List's viewport-safe portal behavior, path containment, truncation,
  Escape handling, and consistent styling.
- Concurrent panes cannot resume the same Codex conversation, and active-writer errors split across
  output chunks recover reliably.
- Agent Sandbox workers run unrestricted and non-interactively by default. Claude uses
  `--dangerously-skip-permissions`; Codex uses unrestricted approvals.
- Sandbox workers use readiness-aware prompt delivery, delayed bracketed paste, separate submission,
  settle detection, deadline fallback, and supported prompt arguments.
- Automated Claude and Codex workers default to Haiku where applicable, preserve their own working
  directories, skip Codex trust checks for the selected Sandbox folder, and report structured errors
  without exposing task text.
- Automated workers move from Working to Done or Error based on streamed output, while submitted
  prompts are cleared to prevent duplicate execution after HMR.
- Sandbox stop and project-switch operations invalidate in-flight spawns, and startup failures release
  the retry guard.
- Windows Sandbox path comparison is case-insensitive and ignores trailing separators.
- Agent Sandbox panes use the same terminal headers, dimensions, backgrounds, and xterm surface as
  regular workspace terminals, with resize and Focus mode support.
- The real planner-to-worker proof of concept replaces mocked communication: Claude plans, Codex works,
  and `/spawn` creates a visible terminal in the session.
- Development-only Welcome, Theme Picker, and Redo Onboarding actions are hidden in production.
- New users receive the default purple avatar when they do not select a custom image.
- Todo items now animate on entry, hover, drag, and reorder targeting.
- Markdown viewer comments and their shortcut are temporarily disabled while the feature is repaired.
- Empty-workspace defaults, disabled-button contrast, sidebar drag previews, and sidebar transitions
  received clearer visual feedback.
- Agent Sandbox evolved from a temporary draggable PTY demonstration into a full-screen, compact,
  design-system-aligned terminal canvas with real providers and messaging.
- Sidebar drop targets now exist only during an active DnD-kit drag.
- Top bar controls, tabs, status pills, and window actions now share consistent spacing, height, and
  radius values; the customization control no longer reserves space while hidden.
- Remote WebSocket clients authenticate before counting toward limits, bind to the selected LAN
  address, strip control characters, and receive restrictive security headers.
- Remote addresses remain hidden behind a generic placeholder until QR pairing completes.
- Form dropdowns now use the compact 32 px system-wide standard.
- Remote security policy, session lifetime, LAN status, and device revocation moved to a dedicated
  Preferences category, leaving the QR dialog focused on quick access.

## [1.4.1] — 2026-08-07

### Fixed

- Corrected release notes in the **What's New** dialog and GitHub release so they use this repository's
  `CHANGELOG.md` instead of a stale external copy.

## [1.4.0] — 2026-08-07

Graphify became optional, the `alethe` command gained direct project opening, and this release delivered
a broad stability and security pass across AgentCanvas networking, image paste, session restoration,
memory controls, and Linux/macOS parity for Antigravity and OpenCode.

### Added

- Added an optional Graphify preference without rewriting agent MCP configuration.
- Added the `alethe` terminal command to open the current or selected directory in the existing app
  window, creating a project only when necessary.
- Added documented code standards and ESLint/Prettier commands.
- Added double-click file opening from File Explorer and monospaced diff panes from Git Control.
- Added **About & Updates** with installed-version details, update checks, download progress, visible
  errors, and a sidebar version shortcut.
- Added real Merge Center review: project validation commands, dedicated reviewer agents, direct
  feedback delivery, heuristic API-contract checks, stack detection, and isolated live health probes.
- Added in-app Git repository initialization with a safe initial commit for features that require Git.
- Added a GSD Planning Completion Gate that always leaves accept, review, and reject decisions available
  to the user and exposes real validation failures.
- Added automatic OpenCode GSD state maintenance for `task.md`, `status.md`, and `progress.md`, plus an
  isolated child session for `goal.md`, `plan.md`, and structured test procedures.
- Added double-click Focus mode for every pane title.
- Added configurable GSD Sync model fallback chains based first on the model that just succeeded in the
  parent conversation.
- Added a project-scoped, read-only GSD Sync viewer with passive completion indication; it was later
  moved into the Tasks sidebar.
- Added code-aware GSD validation planning based on the real changed-file list and structured
  preparation, action, and verification steps in `.planning/procedure.json`.
- Added broader GSD activity triggers so edits and shell work synchronize even without a native task
  list update.
- Added a pre-spawn system-memory headroom check with a 45-second upper bound.
- Added prominent Git initialization to the sidebar and project editor, including empty-repository
  commits and transparent initialization before isolated-agent worktree creation.

### Changed

- GSD Sync sessions moved from a separate right-side drawer into the existing Tasks sidebar.
- Internal quality work moved project persistence off Tokio's blocking path, reduced Ghostty polling,
  consolidated provider session and usage helpers, and standardized the Claude Code label.
- Terminal themes moved from the Terminal settings page to Preferences → Appearance.

### Fixed

- Secured the AgentCanvas local HTTP listener with a per-launch `X-Alethe-Token` and limited request
  bodies to 1 MB.
- Closed sidebars no longer reserve width in the main content area; only top-bar control space remains.
- Stabilized the pane-area Zustand fallback to prevent React #185 during project hydration.
- Disabled unstable xterm.js WebGL rendering in the Windows WebView to avoid teardown races.
- Sidebar resize persistence no longer rebuilds `defaultSize` during the resize event.
- GSD test briefings are scoped to the files changed in the current session and exclude Alethe-generated
  `.opencode/`, `opencode.json`, and `.planning/` infrastructure.
- Graphify and GSD setup commands now run on blocking worker threads instead of freezing Tauri IPC when
  spawning agents.
- PTY write, resize, suspend, kill, and process-tree termination no longer block the Tauri dispatcher or
  hold the global session lock during slow work; process kills have a three-second timeout.
- GSD planning gates skip unsupported providers, install monitoring retroactively for existing OpenCode
  worktrees, and replay task updates queued during an active synchronization cycle.
- Multi-Agent telemetry continues after receiver lag and displays real load failures.
- Onboarding agent detection no longer gets stuck under React StrictMode, and CLI/model discovery runs
  on blocking workers with a six-second per-agent safety limit.
- The Multi-Agent & Telemetry page now reads real `.planning/task.md` data, removes the non-functional
  plugin manager, and routes all visible text through localization.
- The Merge Center has its own maximum height and scroll area so multiple cards cannot push the project
  list out of view.
- Rejecting or accepting worktrees now stops agent processes before deletion, runs Git operations on
  blocking workers, and tracks cleanup failures as recoverable orphaned worktrees.
- Concurrent GSD Sync polling merges only entries resolved by each poll instead of replacing shared
  state, preventing child sessions from flickering or disappearing.
- PTY spawn and scrollback attachment now run on blocking workers so one slow terminal cannot freeze all
  app IPC.
- Deleting a worktree agent also deletes its hidden GSD viewer terminal and PTY.
- Repository-root discovery excludes GSD viewer panes and can resolve the shared Git root from any
  existing worktree.
- GSD viewer panes trust Alethe-tracked child session IDs that OpenCode intentionally omits from normal
  session listings.
- Merge Center **Accept** now performs the real analyze, prepare, resolve, validate, and fast-forward
  merge flow; **Reject** removes the worktree while preserving its branch.
- Automatic worktree isolation applies only to new agents. Existing terminal migration is explicit,
  suspends the PTY, checks uncommitted changes, and reports complete, partial, or failed results.
- Existing-terminal migration validates that the folder is a Git repository before doing any work and
  shows the localized isolation warning instead of a raw Rust error.
- Git initialization seeds a `.gitignore` for common generated and secret directories before staging,
  preventing `node_modules` and similar trees from freezing the app.
- Windows verbatim `\\?\` prefixes are removed from worktree and merge paths before they reach shells,
  session matching, or PTY spawn.
- Session detection for isolated OpenCode, Codex, and Antigravity agents keeps retrying while the
  terminal remains open instead of expiring after 30 seconds.
- New Terminal and Home quick-launch paths once again provision worktrees when automatic isolation is
  enabled and surface provisioning failures in a toast.
- New isolated worktrees always derive from the real repository root instead of nesting under the most
  recently used worktree.
- Test Briefing now shows the real branch file diff and actual validation command results.
- The default Merge Center badge now says **Awaiting action** instead of claiming review readiness.
- Image paste works again for OpenCode, Claude Code, and Codex from screenshots, web images, and Explorer
  files by sending a file path to the PTY.
- Antigravity CLI detection now checks the real `agy` binary on Linux and macOS.
- Closing or restarting terminals now kills complete process trees on Linux and macOS as well as
  Windows.
- Working-directory comparison is centralized and only normalizes case and separators for Windows
  paths.
- Keyboard shortcut labels follow the active platform consistently across Home and the sidebar.
- OpenCode panes claim, persist, and resume their own session IDs instead of falling back to another
  pane's most recent conversation.
- Antigravity sessions use each conversation's timestamp and compare directory boundaries correctly.
- OpenCode directory matching remains case-sensitive on Linux and macOS.
- Enabled `@xterm/addon-unicode11` so emoji and symbol widths match terminal applications.
- **Resume last session** restarts agents through the normal spawn queue and memory supervisor, with
  confirmation when multiple panes will restart.
- The implemented Antigravity usage card now appears in AI Usage Details.
- Antigravity credentials are read from the exact `gemini:antigravity` Windows Credential Manager target
  as UTF-8, allowing real quota display.
- Protected xterm.js renderer changes, writes, and scrolling against disposed-renderer races after
  graphics context loss; PTY suspension now removes the session only after shutdown confirmation.
- Merge Center cards now truncate long status, branch, and action text correctly in narrow sidebars.
- Missing OpenCode sessions with a server-assigned `parent_id` are treated as inconclusive instead of
  being discarded as orphaned.
- Rainbow container borders now draw inside the box with the correct radius, showing the full edge
  animation instead of only the corners.
- Closing Tasks no longer collapses the left Merge Center sidebar after removal of the old GSD drawer.
- A broad silent-failure audit moved Git/session/agent/backup operations off the Tauri dispatcher,
  preserves corrupted metrics instead of overwriting them, exposes restart and hook failures, and keeps
  GSD polling alive when one session fails.

## [1.3.0] — 2026-07-27

This release integrates multi-provider Graphify and macOS contributions, redesigns Home, loading, and
the sidebar, and adds Antigravity support.

### Added

- Added multi-provider Graphify as an MCP server for Claude, Codex, and OpenCode, with a per-project
  graph viewer, project configuration, non-destructive config merging, and graph snapshots.
- Added an opt-in native Ghostty terminal backend on macOS through an NSView layered over the WebView.
- Added AppKit-level rounded window corners on macOS.
- Added Antigravity (`agy`) CLI detection, spawn and resume by conversation, session discovery, and a
  dedicated usage widget.
- Added experimental window opacity control.

### Changed

- Strengthened merge and worktree state with monotonic `projects.json` writes, Git-lock classification,
  backoff, orphan tracking and cleanup, and an auto-finalizing merge state machine.
- Added macOS Keychain discovery for Claude tokens and prevented `EDITOR=vi` from leaking from npm into
  development shells.
- Redesigned Home with interactive ASCII artwork, smooth dashboard transitions, a mini-terminal quick
  launcher, a compact Spotify dock, clearer usage and focus panels, and real streak/activity data.
- Rebuilt the loading screen with animated Alethe ASCII branding and dot-matrix progress.
- Reorganized the Projects sidebar around a fixed active-project card, a flat project list, colored
  monograms, always-visible menus, activity indicators, and reduced metadata clutter.
- Terminal links now exclude explanatory text, input failures recover the PTY, Codex restart preserves
  the conversation, and input focus recovers after mounting, interaction, or graphics loss.
- Unrestricted mode became a prominent one-click control in the Add AI dialog.
- Memory management now monitors by default; intelligent LRU behavior requires explicit opt-in.
- The new-terminal dialog gained card selection, a prominent folder field, and recent-folder shortcuts.
- Automatic resume removes orphaned Claude, Codex, and Antigravity conversation IDs before spawn.

### Fixed

- Windows paths are escaped correctly as TOML strings in `graphify_codex_config_write`.
- The merge finalization fallback stops polling after entering a failed state.

### Removed

- Removed the **Loose/Ungrouped** section label above ungrouped sidebar projects.
- Removed the parked-terminal text notice from the overlay; the resume action remains available.

[Unreleased]: https://github.com/Kc1t/alethe-agents/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/Kc1t/alethe-agents/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/Kc1t/alethe-agents/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/Kc1t/alethe-agents/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Kc1t/alethe-agents/releases/tag/v1.3.0

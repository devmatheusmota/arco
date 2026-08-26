# Releasing Arco

The order below is not a suggestion. Every step exists because skipping it broke
a release that had already reached a user's machine.

## Before anything

The owner authorizes a release explicitly. Cutting a version is a decision, not a
consequence of finishing work — the working tree is where changes stop by
default (see the house rules in `CLAUDE.md`).

## 1. Land the work on `main`

Commit on the working branch, then fast-forward `main` and push it:

```bash
git -C <repo> merge --ff-only <branch>
git -C <repo> push origin main
```

**`main` must contain the release.** A release cut from an agent branch leaves
`main` behind what is installed on people's machines: the next `npm run release`
then produces a version number *lower* than the one already shipped, and its
build silently drops whatever only existed on the branch. This happened between
2.1.1 and 2.2.0.

## 2. Close the changelog

`docs/CHANGELOG.md` keeps everything under `[Unreleased]` while it is being
written. Cutting a version means turning that heading into the version:

```markdown
## [Unreleased]

## [2.2.1] — 2026-08-19

### Fixed
...
```

`[Unreleased]` stays, empty, at the top. Anything left inside it when a version
is cut never gets a date and effectively disappears from the history — that is
how 2.1.2 and 2.2.0 ended up undocumented.

## 3. Update the in-app "What's new"

`docs/CHANGELOG.md` is for the repository. **The dialog the user actually reads
is a different file**, and nothing links them:

1. `src/lib/changelogData.ts` — add the entry at the **top** of
   `CHANGELOG_RELEASES`. The dialog announces the first entry, and
   `CURRENT_VERSION` is derived from it.
2. `src/lib/i18n/messages/en.ts` and `pt-BR.ts` — add the `whatsNew.vXYZ.noteN`
   keys the entry points at. `pt-BR.ts` is typed against `en.ts`, so a missing
   translation fails `npm run build`.

Write the notes for someone who did not read the code: what changed for them,
and what they have to do about it (reinstall the terminal command, add a token,
turn a preference on).

`src/lib/changelogData.test.ts` fails the suite when the shipping version has no
entry, when it is not first, or when the list is out of order.

## 4. Verify

```bash
npm run build   # tsc + i18n validation + vite
npm test        # the suite, including the changelog guard
```

For anything the user can see, also run it: `npm run app`, or a packaged build.
A screenshot of the actual change beats reasoning about it.

## 5. Cut the version

```bash
npm run release            # patch:  2.2.0 -> 2.2.1
npm run release minor      # feature work
npm run release major
npm run release -- --dry-run
```

The script keeps `package.json`, `src-tauri/tauri.conf.json`, `Cargo.toml` and
`Cargo.lock` in sync, commits, tags and pushes. It refuses to run when the
changelog or the What's new entry for the new version is missing, and when
`[Unreleased]` still holds content that did not make it into the version.

Pushing the tag is what publishes: the Release workflow runs on every `v*` tag,
and builds the tag itself rather than whatever `main` holds later.

## 6. Watch the publish

```bash
gh run watch               # the tag already started the Release workflow
npm run release:publish    # only to re-dispatch one that failed halfway
```

The workflow builds Linux first and publishes the release as soon as that
finishes — the `.deb` feeds the apt repository, and holding it back for a macOS
runner sitting in a queue delays the update everyone actually installs. Windows
and macOS attach themselves to the same release as each one finishes.

The publish job starts the apt workflow itself; it does not wait for the whole
run to complete.

The Homebrew tap is the one thing that waits for every macOS build: a cask
published with one architecture missing fails to install on the other. It is
updated by `scripts/update-homebrew-tap.mjs`, which rewrites `Casks/arco.rb` in
[`devmatheusmota/homebrew-arco`](https://github.com/devmatheusmota/homebrew-arco)
from the digests GitHub already computed for the release assets — no download.

That push crosses repositories, which `GITHUB_TOKEN` cannot do: it needs a
`HOMEBREW_TAP_TOKEN` secret holding a PAT with `contents: write` on the tap.
Without it the step says what is missing and passes — a tap one version behind
must not fail a release that already shipped everywhere else — so check the job's
log when `brew upgrade` stops seeing new versions.

## 7. Confirm it reached the user

```bash
gh run view <id> --json status,jobs --jq '.status, (.jobs[] | {name, conclusion})'
gh release view v<version> --json assets --jq '.assets[].name'
curl -s https://devmatheusmota.github.io/arco/dists/stable/main/binary-amd64/Packages | head -4
```

The apt index must report the new version. `sudo apt update && sudo apt upgrade`
on the machine is the last check.

Installing the `.deb` does not update the `arco` shim in `~/.local/bin`. When the
release changes the command line, say so: it is reinstalled from
**Preferences → Integrations → Terminal command**.

## What breaks releases here

- Cutting from a branch and leaving `main` behind (§1).
- Leaving entries under `[Unreleased]` (§2).
- Updating the changelog but not the dialog — the user sees the old version and
  concludes the update never arrived (§3).
- Waiting on every platform before publishing: the macOS Intel runner routinely
  queues for hours (§6).

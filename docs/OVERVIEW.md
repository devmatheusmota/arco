# Arco Overview

Arco is a desktop workspace for running coding agents and shells side by side. It turns terminals into persistent workspace units: each pane has its own cwd, PTY, scrollback, tabs, layout state, and local resume data.

The app is local-first. Projects, preferences, layouts, scrollback, sessions, and Spotify credentials stay on the user's machine unless an optional cloud service is added later.

## What It Provides

- A project-based workspace for Shell, Claude Code, Codex, and OpenCode.
- Real PTYs managed by a Rust/Tauri backend.
- Split-pane project containers with automatic and custom grid layouts.
- Groups and subgroups for larger workspaces.
- Multiple sub-tabs inside each terminal.
- Persisted local state across restarts.
- Session resume for supported agent CLIs.
- Memory controls for disabling terminals and suspending groups.
- Backup export/import for local data.

## Stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 |
| Backend | Rust |
| Frontend | React 18, TypeScript, Vite |
| State | Zustand |
| Terminal | `xterm.js` |
| PTY | `portable-pty` |
| Layout | `react-resizable-panels`, CSS grid |
| Drag and drop | `@dnd-kit/core` |
| Persistence | Local JSON files and scrollback files |

## Core Model

```text
Group
└── Project
    └── Terminal
        ├── Shell tab
        ├── Claude Code tab
        └── Codex tab
```

- **Group**: a logical collection of projects.
- **Project**: a work unit with terminals, layout, color, and workspace state.
- **Container**: the visual representation of an opened project.
- **Pane**: a terminal rendered inside a container.
- **Terminal**: a persistent unit with cwd, sub-tabs, PTY state, and scrollback.
- **Sub-tab**: an internal tab inside a terminal, usually mapped to one agent or shell.

## Persistence

Arco stores app data under the platform app-data directory. Each local profile/account has its own isolated data folder.

Typical files include:

- `profiles.json`: local account/profile registry.
- `profiles/<profileId>/projects.json`: projects, groups, workspace state, preferences, and CLI paths.
- `profiles/<profileId>/scrollback/`: terminal scrollback snapshots.
- `profiles/<profileId>/spotify_tokens.json`: local Spotify token cache, when configured.
- `profiles/<profileId>/spawn.log`: local spawn and diagnostic log.

## Development

```sh
npm install
npm run app
npm run build
npm run tauri -- build
```

Build artifacts are written to:

```text
src-tauri/target/release/bundle/
```

## Current Scope

Arco is currently focused on the local desktop app. Windows is the most tested platform, while Linux and macOS builds are supported by the release workflow and need broader real-machine validation.

Cloud sync, hosted backup, billing, and online services are intentionally separate from the local app.

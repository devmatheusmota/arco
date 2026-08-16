# Arco Brand and Design Tokens

This file documents the public app assets and the core design tokens used by the interface.

## Logo and Icons

- Main mark: [src/assets/arco-mark.svg](../src/assets/arco-mark.svg)
- Loading mark: [src/assets/arco-loading-mark.png](../src/assets/arco-loading-mark.png)
- Default profile avatar: [src/assets/default-profile.svg](../src/assets/default-profile.svg)
- App icons: [src-tauri/icons/](../src-tauri/icons/)

To regenerate Tauri app icons from a new source image:

```sh
npx tauri icon ./logo.png
```

## Agent Assets

| Agent | Asset | Identity color |
|---|---|---|
| Shell | inline icon | `#10b981` |
| Claude Code | [src/assets/claude-code.png](../src/assets/claude-code.png) | `#ec9333` |
| Codex | [src/assets/codex.png](../src/assets/codex.png) | `#06b6d4` |
| OpenCode light | [src/assets/open-black.png](../src/assets/open-black.png) | `#8b8b95` |
| OpenCode dark | [src/assets/open-white.png](../src/assets/open-white.png) | `#8b8b95` |
| VS Code | [src/assets/vscode.svg](../src/assets/vscode.svg) | `#007ACC` |

## Typography

| Token | Value |
|---|---|
| `--font-sans` | `Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif` |
| `--font-mono` | `"Cascadia Mono", Consolas, "Courier New", monospace` |

The sans font is used for the product UI. The mono font is used for cwd labels, terminal-adjacent metadata, badges, and code-like values.

## Global Surfaces

| Token | Value | Usage |
|---|---|---|
| `--surface-modal` | `#1f2125` | Modal surfaces |
| `--surface-card-default` | `#2a2d33` | List cards and metric cards |
| `--surface-card-selected` | `rgba(243,244,246,0.06)` | Active cards |
| `--border-subtle` | `#2a2d33` | Standard separators |
| `--border-accent` | `rgba(243,244,246,0.22)` | Focus and active borders |

## Text

| Token | Value | Usage |
|---|---|---|
| `--text-primary` | `#f3f4f6` | Main text |
| `--text-secondary` | `#c8c8d0` | Secondary copy |
| `--text-tertiary` | `#8b8b95` | Hints and metadata |
| `--text-quaternary` | `#6b6b75` | Disabled text and placeholders |

## Agent Colors

| Token | Value | Soft variant |
|---|---|---|
| `--agent-shell` | `#10b981` | `rgba(16,185,129,0.14)` |
| `--agent-claude` | `#ec9333` | `rgba(236,147,51,0.15)` |
| `--agent-codex` | `#06b6d4` | `rgba(6,182,212,0.15)` |
| `--agent-opencode` | `#8b8b95` | `rgba(139,139,149,0.15)` |

## Status Colors

| Token | Value | Meaning | Soft variant |
|---|---|---|---|
| `--status-active` | `#10b981` | working, tool-running, thinking | `rgba(16,185,129,0.16)` |
| `--status-waiting` | `#f59e0b` | waiting, approval needed | `rgba(245,158,11,0.16)` |
| `--status-idle` | `#8b8b95` | stopped, idle, disabled | `rgba(139,139,149,0.14)` |

## Terminal Themes

| Theme | Background | Foreground | Cursor | Selection |
|---|---|---|---|---|
| Dark | `#101114` | `#f3f4f6` | `#f3f4f6` | `#3b82f666` |
| Light | `#fafafa` | `#18181b` | `#18181b` | `#3b82f655` |

## Project Colors

| Name | Hex |
|---|---|
| Orange | `#f97316` |
| Pink | `#ec4899` |
| Purple | `#8b5cf6` |
| Blue | `#0ea5e9` |
| Teal | `#14b8a6` |
| Green | `#84cc16` |
| Yellow | `#eab308` |
| Red | `#ef4444` |
| Gray | `#64748b` |
| Black | `#0a0a0a` |
| Auto | inherit |

## Radius

| Token | Value |
|---|---|
| `--radius-sm` | `4px` |
| `--radius-md` | `8px` |
| `--radius-lg` | `14px` |

Common usage:

- Small controls: `5-6px`.
- Cards: `8px`.
- Modals: `12-14px`.
- Pills and traffic lights: `999px`.

## Trademark

The Arco name, logo, and official branding are reserved for official builds. See [TRADEMARK.md](../TRADEMARK.md).

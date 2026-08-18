// Git commands, shelling out to the git binary.
//
// Same surface the Rust backend exposes to the sidebar: status, staging, diffs,
// branches and the worktree operations Arco uses to isolate agents.

const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const MAX_BUFFER = 32 * 1024 * 1024

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || error.message))
        else resolve(stdout)
      },
    )
  })
}

async function repoRootOf(target) {
  const start =
    fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target)
  const out = await git(['rev-parse', '--show-toplevel'], start)
  return out.trim()
}

/** Maps a porcelain v1 XY pair onto the status strings the UI renders. */
function statusLabel(code) {
  switch (code) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case '?':
      return 'untracked'
    case 'U':
      return 'conflict'
    default:
      return 'modified'
  }
}

function parsePorcelain(output) {
  const staged = []
  const changes = []
  const untracked = []
  const conflicts = []
  for (const line of output.split('\n')) {
    if (line.length < 4) continue
    const index = line[0]
    const worktree = line[1]
    let rest = line.slice(3)
    let originalPath = null
    if (rest.includes(' -> ')) {
      const [from, to] = rest.split(' -> ')
      originalPath = from
      rest = to
    }
    const entry = {
      path: rest,
      originalPath,
      status: statusLabel(index !== ' ' ? index : worktree),
    }
    if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A')) {
      conflicts.push({ ...entry, status: 'conflict' })
      continue
    }
    if (index === '?' && worktree === '?') {
      untracked.push({ ...entry, status: 'untracked' })
      continue
    }
    if (index !== ' ') staged.push({ ...entry, status: statusLabel(index) })
    if (worktree !== ' ') changes.push({ ...entry, status: statusLabel(worktree) })
  }
  return { staged, changes, untracked, conflicts }
}

async function status(target) {
  const repoRoot = await repoRootOf(target)
  const [porcelain, branchLine] = await Promise.all([
    git(['status', '--porcelain'], repoRoot),
    git(['status', '-sb', '--porcelain'], repoRoot).then((out) => out.split('\n')[0] ?? ''),
  ])
  const branchMatch = branchLine.match(/^## (?:No commits yet on )?([^.\s]+)/)
  const ahead = Number(branchLine.match(/ahead (\d+)/)?.[1] ?? 0)
  const behind = Number(branchLine.match(/behind (\d+)/)?.[1] ?? 0)
  const detached = branchLine.includes('HEAD (no branch)')
  return {
    repoRoot,
    branch: detached ? 'HEAD' : (branchMatch?.[1] ?? 'HEAD'),
    detached,
    ahead,
    behind,
    ...parsePorcelain(porcelain),
  }
}

function buildGitCommands() {
  return {
    git_status: ({ path: target }) => status(target),
    git_init: async ({ path: target }) => {
      await git(['init'], target)
      return target
    },
    git_stage: async ({ repoRoot, paths }) => {
      await git(['add', '--', ...(paths ?? [])], repoRoot)
      return null
    },
    git_unstage: async ({ repoRoot, paths }) => {
      await git(['restore', '--staged', '--', ...(paths ?? [])], repoRoot)
      return null
    },
    git_discard: async ({ repoRoot, paths }) => {
      await git(['checkout', '--', ...(paths ?? [])], repoRoot)
      return null
    },
    git_diff: ({ repoRoot, path: target, staged }) =>
      git(['diff', ...(staged ? ['--staged'] : []), '--', target], repoRoot).catch(() => ''),
    git_diff_summary: async ({ repoRoot, source, target, worktreePath }) => {
      const cwd = worktreePath || repoRoot
      const range = source && target ? [`${source}...${target}`] : []
      const out = await git(['diff', '--name-status', ...range], cwd).catch(() => '')
      return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [code, ...rest] = line.split('\t')
          return { path: rest[rest.length - 1] ?? '', status: statusLabel(code[0]) }
        })
    },
    git_commit: async ({ repoRoot, message }) => {
      await git(['commit', '-m', message], repoRoot)
      return null
    },
    git_push: async ({ repoRoot }) => {
      await git(['push'], repoRoot)
      return null
    },
    git_pull: async ({ repoRoot }) => {
      await git(['pull', '--ff-only'], repoRoot)
      return null
    },
    git_list_branches: async ({ repoRoot }) => {
      const out = await git(['branch', '--format=%(refname:short)'], repoRoot).catch(() => '')
      return out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    },
    clone_github_repo: async ({ url, targetDir }) => {
      await git(['clone', url, targetDir], path.dirname(targetDir))
      return targetDir
    },

    // Worktrees: read-only for now, so the UI can list what exists. Creating
    // and removing them still belongs to the Tauri build.
    worktree_list: async ({ repoRoot }) => {
      const out = await git(['worktree', 'list', '--porcelain'], repoRoot).catch(() => '')
      const entries = []
      let current = null
      for (const line of out.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (current) entries.push(current)
          current = { agentId: '', path: line.slice(9), branch: '', createdAt: 0 }
        } else if (line.startsWith('branch ') && current) {
          current.branch = line.slice(7).replace('refs/heads/', '')
        }
      }
      if (current) entries.push(current)
      return entries
    },
  }
}

module.exports = { buildGitCommands }

// Agent worktrees and the remaining odds and ends.
//
// Arco isolates each agent in its own git worktree under `.arco/worktrees/<id>`
// on a branch named `arco/agent-<id>`. This keeps that layout so a worktree
// created by one shell is understood by the other.

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const paths = require('./paths.cjs')

const WORKTREE_ROOT = ['.arco', 'worktrees']

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message))
      else resolve(stdout)
    })
  })
}

function worktreePath(repo, agentId) {
  return path.join(repo, ...WORKTREE_ROOT, agentId)
}

function branchName(agentId) {
  return `arco/agent-${agentId}`
}

async function info(repo, agentId) {
  const target = worktreePath(repo, agentId)
  let createdAt = 0
  try {
    createdAt = fs.statSync(target).birthtimeMs || fs.statSync(target).ctimeMs
  } catch {}
  return { agentId, path: target, branch: branchName(agentId), createdAt }
}

function buildWorktreeCommands() {
  return {
    worktree_provision: async ({ repo, agentId, mode }) => {
      const target = worktreePath(repo, agentId)
      if (fs.existsSync(target)) {
        // A directory is not proof of a worktree. A provision interrupted
        // halfway leaves the folder behind without the `.git` file that makes
        // it one, and accepting it hands the agent a checkout git knows nothing
        // about. The remains are kept — they may hold work — and moved aside so
        // a real worktree can take the name.
        if (mode === 'localCopy' || fs.existsSync(path.join(target, '.git'))) {
          return info(repo, agentId)
        }
        const salvaged = `${target}.broken-${Date.now()}`
        try {
          fs.renameSync(target, salvaged)
        } catch (error) {
          throw new Error(`worktree ${target} is incomplete and cannot be moved`, { cause: error })
        }
        await git(['worktree', 'prune'], repo).catch(() => null)
      }
      paths.ensureDir(path.dirname(target))
      if (mode === 'localCopy') {
        await new Promise((resolve, reject) => {
          execFile('cp', ['-a', repo, target], (error) => (error ? reject(error) : resolve()))
        })
        return info(repo, agentId)
      }
      const branch = branchName(agentId)
      const exists = await git(['rev-parse', '--verify', branch], repo)
        .then(() => true)
        .catch(() => false)
      await git(
        exists
          ? ['worktree', 'add', target, branch]
          : ['worktree', 'add', '-b', branch, target, 'HEAD'],
        repo,
      )
      return info(repo, agentId)
    },
    worktree_remove: async ({ repo, agentId, force }) => {
      const target = worktreePath(repo, agentId)
      await git(['worktree', 'remove', ...(force ? ['--force'] : []), target], repo).catch(
        () => null,
      )
      return null
    },
    worktree_cleanup: async ({ repo }) => {
      await git(['worktree', 'prune'], repo).catch(() => null)
      return null
    },
    worktree_fetch_branch: async ({ repo, agentId }) => {
      await git(['fetch', 'origin', branchName(agentId)], repo).catch(() => null)
      return null
    },
    worktree_lock: async ({ repo, agentId, reason }) => {
      await git(
        ['worktree', 'lock', ...(reason ? ['--reason', reason] : []), worktreePath(repo, agentId)],
        repo,
      ).catch(() => null)
      return null
    },
    worktree_unlock: async ({ repo, agentId }) => {
      await git(['worktree', 'unlock', worktreePath(repo, agentId)], repo).catch(() => null)
      return null
    },

    /** Reads the manifests present to tell the UI what kind of project this is. */
    detect_project_stack: ({ path: repo }) => {
      if (!repo) return null
      const has = (name) => fs.existsSync(path.join(repo, name))
      const stacks = []
      if (has('package.json')) stacks.push('node')
      if (has('Cargo.toml')) stacks.push('rust')
      if (has('pyproject.toml') || has('requirements.txt')) stacks.push('python')
      if (has('go.mod')) stacks.push('go')
      if (has('pom.xml') || has('build.gradle')) stacks.push('jvm')
      if (has('Gemfile')) stacks.push('ruby')
      return { stacks, primary: stacks[0] ?? null }
    },

    get_last_crash_report: () => {
      const file = path.join(paths.logsDir(), 'last_session.json')
      const record = paths.readJson(file, null)
      if (!record || record.clean_exit !== false) return null
      return { session: record, orphans_reaped: 0 }
    },
  }
}

module.exports = { buildWorktreeCommands }

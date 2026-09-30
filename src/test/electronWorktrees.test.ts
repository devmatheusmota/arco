import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

type WorktreeEntry = { agentId: string; path: string; branch: string; mode: string }

const require = createRequire(import.meta.url)
const { excludeArcoLocally, list, provision, remove } =
  require('../../electron/commands/worktrees.cjs') as {
    excludeArcoLocally: (repo: string) => void
    list: (args: { repo: string }) => Promise<WorktreeEntry[]>
    provision: (args: { repo: string; agentId: string; mode?: string }) => Promise<unknown>
    remove: (args: { repo: string; agentId: string; force?: boolean }) => Promise<null>
  }

let repo = ''
const excludeFile = () => join(repo, '.git', 'info', 'exclude')
const read = () => readFileSync(excludeFile(), 'utf8')

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'arco-worktrees-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('excludeArcoLocally', () => {
  // `.arco/` shows up as untracked in every `git status` of a repository that
  // has a worktree, which is noise in the one command used to decide whether
  // there is uncommitted work.
  it('hides .arco/ without touching a versioned file', () => {
    excludeArcoLocally(repo)

    expect(read()).toMatch(/^\.arco\/$/m)
    const tracked = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    expect(tracked).toBe('')
  })

  it('writes the rule once, however many worktrees are provisioned', () => {
    excludeArcoLocally(repo)
    excludeArcoLocally(repo)
    excludeArcoLocally(repo)

    expect(read().match(/^\.arco\/$/gm)).toHaveLength(1)
  })

  it('keeps what the file already had, and does not glue itself to the last line', () => {
    writeFileSync(excludeFile(), '# meus\n*.local')
    excludeArcoLocally(repo)

    const text = read()
    expect(text).toContain('*.local')
    expect(text).toMatch(/\*\.local\n/)
    expect(text).toMatch(/^\.arco\/$/m)
  })

  it('leaves a linked worktree alone: its .git is a file, and info/ is not its own', () => {
    const linked = join(repo, 'linked')
    mkdirSync(linked)
    writeFileSync(join(linked, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'linked')}\n`)

    expect(() => excludeArcoLocally(linked)).not.toThrow()
  })

  it('says nothing when the directory is not a repository at all', () => {
    const plain = mkdtempSync(join(tmpdir(), 'arco-plain-'))
    expect(() => excludeArcoLocally(plain)).not.toThrow()
    rmSync(plain, { recursive: true, force: true })
  })
})

describe('provision', () => {
  // Every repository that already had worktrees before this existed would never
  // reach the creation path again, so writing the rule only when a worktree is
  // created left those repositories showing `?? .arco/` forever. Attaching to a
  // worktree that is already there is the moment they do come through.
  it('hides .arco/ even when the worktree is already there and nothing is created', async () => {
    const existing = join(repo, '.arco', 'worktrees', 'cl-1')
    mkdirSync(existing, { recursive: true })
    writeFileSync(join(existing, '.git'), 'gitdir: elsewhere\n')

    await provision({ repo, agentId: 'cl-1' })

    expect(read()).toMatch(/^\.arco\/$/m)
  })

  it('writes the rule when it does create the worktree', async () => {
    writeFileSync(join(repo, 'README.md'), '# repo\n')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first'], {
      cwd: repo,
    })

    await provision({ repo, agentId: 'cl-2' })

    expect(read()).toMatch(/^\.arco\/$/m)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe('')
  })
})

function commitSomething() {
  writeFileSync(join(repo, 'README.md'), '# repo\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first'], {
    cwd: repo,
  })
}

const gitWorktrees = () =>
  execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })

describe('list', () => {
  // Closing a front finds its worktree here by id. Entries without one read as
  // "already gone", and the front closed with the worktree left on disk.
  it('names each worktree by the id it was provisioned with', async () => {
    commitSomething()
    await provision({ repo, agentId: 'cl-2' })

    const entries = await list({ repo })

    // Exactly one: the listing is of the repository it was given, not of the
    // directory the app happens to run in.
    expect(entries).toEqual([
      expect.objectContaining({
        agentId: 'cl-2',
        path: join(repo, '.arco', 'worktrees', 'cl-2'),
        branch: 'arco/agent-cl-2',
        mode: 'gitWorktree',
      }),
    ])
  })

  it('leaves out a directory that is neither a worktree nor a copy', async () => {
    mkdirSync(join(repo, '.arco', 'worktrees', 'half-made'), { recursive: true })

    expect(await list({ repo })).toEqual([])
  })

  it('is empty for a repository without worktrees', async () => {
    expect(await list({ repo })).toEqual([])
  })
})

describe('remove', () => {
  it('takes a clean worktree out of git worktree list', async () => {
    commitSomething()
    await provision({ repo, agentId: 'cl-2' })
    expect(gitWorktrees()).toContain('cl-2')

    await remove({ repo, agentId: 'cl-2', force: true })

    expect(gitWorktrees()).not.toContain('cl-2')
    expect(await list({ repo })).toEqual([])
  })

  it('says worktree_not_found when there is nothing to remove', async () => {
    await expect(remove({ repo, agentId: 'cl-9', force: true })).rejects.toThrow(
      'worktree_not_found',
    )
  })

  // A failure used to be swallowed and reported as done, so the caller never
  // learned the worktree was still there.
  it('fails loudly on a directory it will not delete, and keeps it', async () => {
    const leftover = join(repo, '.arco', 'worktrees', 'half-made')
    mkdirSync(leftover, { recursive: true })
    writeFileSync(join(leftover, 'notes.txt'), 'work\n')

    await expect(remove({ repo, agentId: 'half-made', force: true })).rejects.toThrow(
      'not_a_worktree',
    )
    expect(readFileSync(join(leftover, 'notes.txt'), 'utf8')).toBe('work\n')
  })

  it('refuses an id that climbs out of .arco/worktrees', async () => {
    await expect(remove({ repo, agentId: '../../x', force: true })).rejects.toThrow(
      'invalid_worktree_path',
    )
  })
})

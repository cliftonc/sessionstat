import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from './log.js'
import { paths } from './paths.js'

/**
 * Adapted from guidemode `packages/cli/src/utils/spawn-worker.ts`: the per-key lock with a
 * "dirty" marker (so a burst of hooks runs one worker that re-runs once), stale-lock breaking,
 * and the detached spawn. The key here is a repo+branch, not a session, because what a worker
 * produces is one PR comment.
 */

/** A worker that has held the lock this long has died; break it rather than stall forever. */
const LOCK_TTL_MS = 10 * 60 * 1000

export function keyFor(repoRoot: string, branch: string): string {
  return createHash('sha256').update(`${repoRoot}\0${branch}`).digest('hex').slice(0, 16)
}

function lockPath(key: string): string {
  return join(paths.locks(), `${key}.lock`)
}

function dirtyPath(key: string): string {
  return join(paths.locks(), `${key}.dirty`)
}

async function isLockStale(path: string, now: number): Promise<boolean> {
  let held: { at?: unknown; pid?: unknown }
  try {
    held = JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return true
  }
  if (typeof held.at !== 'number' || !Number.isFinite(held.at)) return true
  if (typeof held.pid === 'number' && !isAlive(held.pid)) return true
  return Math.abs(now - held.at) > LOCK_TTL_MS
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, it is just not ours.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Take a lock file, breaking it if its holder is dead or it is older than `ttlMs`. */
export async function acquireLock(
  path: string,
  ttlMs: number = LOCK_TTL_MS,
  now: number = Date.now()
): Promise<boolean> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  const body = JSON.stringify({ pid: process.pid, at: now })
  try {
    await writeFile(path, body, { flag: 'wx' })
    return true
  } catch {
    const stale = (await isLockStale(path, now)) || (await olderThan(path, ttlMs, now))
    if (!stale) return false
    try {
      await rm(path, { force: true })
      await writeFile(path, body, { flag: 'wx' })
      await log('WARN', `Broke stale lock ${path}`)
      return true
    } catch {
      return false
    }
  }
}

async function olderThan(path: string, ttlMs: number, now: number): Promise<boolean> {
  try {
    const held = JSON.parse(await readFile(path, 'utf-8')) as { at?: number }
    return typeof held.at === 'number' && now - held.at > ttlMs
  } catch {
    return true
  }
}

export async function acquirePostLock(key: string): Promise<boolean> {
  return acquireLock(lockPath(key))
}

export async function markDirty(key: string): Promise<void> {
  try {
    await mkdir(paths.locks(), { recursive: true, mode: 0o700 })
    await writeFile(dirtyPath(key), '', { mode: 0o600 })
  } catch {
    // Best effort.
  }
}

export async function consumeDirty(key: string): Promise<boolean> {
  try {
    await stat(dirtyPath(key))
  } catch {
    return false
  }
  await rm(dirtyPath(key), { force: true })
  return true
}

export async function releasePostLock(key: string): Promise<void> {
  await rm(dirtyPath(key), { force: true })
  await rm(lockPath(key), { force: true })
}

/**
 * Has this exact hook invocation already been handled?
 *
 * With hooks installed at both user and project scope, Claude Code runs both commands for one
 * event, with byte-identical stdin, within milliseconds. The first to claim the payload's hash
 * does the work; the second sees the marker and exits. The window is short so that a genuinely
 * new event with the same payload (two `Stop`s in a row) is not swallowed.
 */
export async function claimHookEvent(
  rawStdin: string,
  windowMs = 5000,
  now: number = Date.now()
): Promise<boolean> {
  const dir = paths.dedupe()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, createHash('sha256').update(rawStdin).digest('hex').slice(0, 24))
  try {
    await writeFile(file, String(now), { flag: 'wx' })
    // File mtimes are wall-clock, so the sweep uses the real clock, not an injected one.
    void sweepDedupe(dir, Date.now(), windowMs)
    return true
  } catch {
    try {
      const at = Number(await readFile(file, 'utf-8'))
      if (Number.isFinite(at) && now - at < windowMs) return false
      await writeFile(file, String(now))
      return true
    } catch {
      return true
    }
  }
}

async function sweepDedupe(dir: string, now: number, windowMs: number): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      const file = join(dir, name)
      const { mtimeMs } = await stat(file)
      if (now - mtimeMs > windowMs * 12) await rm(file, { force: true })
    }
  } catch {
    // Best effort.
  }
}

/**
 * Run a sessionstat subcommand in a detached background process and return immediately.
 *
 * Claude Code waits for the hook to exit, so anything slow (gh, parsing a large transcript)
 * happens here. Re-invokes through `process.execPath` and `argv[1]` rather than the
 * `sessionstat` name, which is not guaranteed to be on the hook's PATH.
 */
export type Spawner = (args: string[]) => void

export const spawnDetached: Spawner = args => {
  const entry = process.argv[1]
  if (!entry) throw new Error('Cannot determine CLI entry point to spawn a worker')
  const child = spawn(process.execPath, [entry, ...args], { detached: true, stdio: 'ignore' })
  child.unref()
}

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from './log.js'
import { paths } from './paths.js'
import { type PostDeps, type PostOutcome, postForBranch } from './post.js'
import {
  acquireLock,
  acquirePostLock,
  consumeDirty,
  isAlive,
  keyFor,
  markDirty,
  releasePostLock,
} from './worker.js'

/**
 * Checks after a session ends.
 *
 * People usually open the PR after the agent has finished, so the last hook of the session has
 * nothing to post to. `SessionEnd` queues a few follow-up looks at the branch; a detached
 * poller (one at a time) wakes for them, and every hook run, in any repository, starts a new
 * poller if one is overdue - which is how a poller killed by a reboot or a laptop lid gets
 * caught up. No launchd, no cron.
 */
export const CHECK_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]

/** Longer than the last delay, so a live poller's lock is never mistaken for a dead one. */
const POLLER_LOCK_TTL_MS = 3 * 60 * 60_000
/** The poller re-reads the queue at least this often, so checks queued while it sleeps count. */
const MAX_SLEEP_MS = 60_000
const MAX_WORKER_PASSES = 5

export interface PrCheck {
  repoRoot: string
  branch: string
  createdAt: number
  /** Epoch ms, ascending. Each is removed once it has been acted on. */
  dueAt: number[]
}

function checkPath(repoRoot: string, branch: string): string {
  return join(paths.prChecks(), `${keyFor(repoRoot, branch)}.json`)
}

async function writeCheck(check: PrCheck): Promise<void> {
  await mkdir(paths.prChecks(), { recursive: true, mode: 0o700 })
  const file = checkPath(check.repoRoot, check.branch)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(check, null, 2), { mode: 0o600 })
  await rename(tmp, file)
}

/** Queue (or re-queue from now) the follow-up checks for a branch. */
export async function queueChecks(repoRoot: string, branch: string, now: number): Promise<PrCheck> {
  const check: PrCheck = {
    repoRoot,
    branch,
    createdAt: now,
    dueAt: CHECK_DELAYS_MS.map(delay => now + delay),
  }
  await writeCheck(check)
  return check
}

export async function listChecks(): Promise<PrCheck[]> {
  let files: string[]
  try {
    files = await readdir(paths.prChecks())
  } catch {
    return []
  }
  const checks: PrCheck[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      checks.push(JSON.parse(await readFile(join(paths.prChecks(), file), 'utf-8')) as PrCheck)
    } catch {
      // Torn write; the next write replaces it.
    }
  }
  return checks
}

export async function hasDueChecks(now: number): Promise<boolean> {
  return (await listChecks()).some(c => c.dueAt.length > 0 && c.dueAt[0] <= now)
}

export async function nextDueAt(): Promise<number | null> {
  const all = (await listChecks()).flatMap(c => c.dueAt)
  return all.length > 0 ? Math.min(...all) : null
}

/**
 * Claim every check that is due. All past-due times for a branch collapse into one look (a
 * poller that slept through two of them should not post twice), and a branch with no times
 * left is removed: after the last check we give up.
 */
export async function takeDueChecks(now: number): Promise<PrCheck[]> {
  const due: PrCheck[] = []
  for (const check of await listChecks()) {
    if (check.dueAt.length === 0 || check.dueAt[0] > now) continue
    due.push(check)
    const remaining = check.dueAt.filter(t => t > now)
    if (remaining.length === 0) await rm(checkPath(check.repoRoot, check.branch), { force: true })
    else await writeCheck({ ...check, dueAt: remaining })
  }
  return due
}

export async function removeChecks(repoRoot: string, branch: string): Promise<void> {
  await rm(checkPath(repoRoot, branch), { force: true })
}

/**
 * Post under the repo+branch lock. If another worker holds it, leave a marker so the holder runs
 * once more when it finishes, and return without posting (`null`).
 */
export async function postWithLock(
  repoRoot: string,
  branch: string,
  deps: PostDeps
): Promise<PostOutcome | null> {
  const key = keyFor(repoRoot, branch)
  if (!(await acquirePostLock(key))) {
    await markDirty(key)
    return null
  }
  try {
    let outcome = await postForBranch(repoRoot, branch, deps)
    for (let pass = 1; pass < MAX_WORKER_PASSES && (await consumeDirty(key)); pass++) {
      outcome = await postForBranch(repoRoot, branch, deps)
    }
    return outcome
  } finally {
    await releasePostLock(key)
  }
}

export async function runDueChecks(deps: PostDeps & { clock: () => number }): Promise<number> {
  const due = await takeDueChecks(deps.clock())
  for (const check of due) {
    try {
      const outcome = await postWithLock(check.repoRoot, check.branch, deps)
      await log(
        'INFO',
        `Scheduled check ${check.repoRoot} ${check.branch}: ${outcome?.status ?? 'busy'}`
      )
    } catch (err) {
      await log('ERROR', `Scheduled check failed for ${check.repoRoot} ${check.branch}: ${err}`)
    }
  }
  return due.length
}

export interface PollerDeps extends PostDeps {
  clock: () => number
  sleep: (ms: number) => Promise<void>
}

/** Is a poller alive right now? */
export async function pollerRunning(): Promise<boolean> {
  try {
    const held = JSON.parse(await readFile(paths.pollerLock(), 'utf-8')) as { pid?: number }
    return typeof held.pid === 'number' && isAlive(held.pid)
  } catch {
    return false
  }
}

/**
 * The single poller. Returns false straight away if another one holds the lock. Otherwise runs
 * whatever is due, sleeps until the next check (re-reading the queue at least once a minute),
 * and exits when nothing is left.
 */
export async function runPoller(deps: PollerDeps): Promise<boolean> {
  if (!(await acquireLock(paths.pollerLock(), POLLER_LOCK_TTL_MS, deps.clock()))) return false
  try {
    for (;;) {
      await runDueChecks(deps)
      const next = await nextDueAt()
      if (next === null) return true
      const wait = Math.max(0, Math.min(next - deps.clock(), MAX_SLEEP_MS))
      if (wait > 0) await deps.sleep(wait)
    }
  } finally {
    await rm(paths.pollerLock(), { force: true })
  }
}

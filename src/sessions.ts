import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Billing } from './billing.js'
import { paths } from './paths.js'

/**
 * What a hook knows about a session: where its transcript is and which repo/branches it touched.
 * Written by the hook, read when posting. Stats are never stored here; they are computed from
 * the transcript at post time.
 */
export interface SessionRecord {
  sessionId: string
  transcriptPath: string
  cwd: string
  repoRoot: string
  remote: string | null
  /** Every branch the session was seen on, in first-seen order. */
  branches: string[]
  firstSeenAt: string
  lastSeenAt: string
  endedAt?: string
  /**
   * Did the branch already have an open PR when the session started? Recorded at SessionStart
   * from the lookup the notice does. Absent when unknown (no SessionStart seen, or gh timed out);
   * posting then falls back to comparing the start time with the PR's creation time.
   */
  openedBeforePr?: boolean
  /** HEAD when the session was first seen, so commits it already had are not credited to it. */
  startHead?: string
  /** HEAD commits first seen at the end of a turn, per branch. */
  commits: Array<{ branch: string; sha: string }>
  /** Who pays for the session, detected in the hook's environment. Absent on older records. */
  billing?: Billing
}

function recordPath(sessionId: string): string {
  return join(paths.sessions(), `${encodeURIComponent(sessionId)}.json`)
}

export async function readSession(sessionId: string): Promise<SessionRecord | null> {
  try {
    return JSON.parse(await readFile(recordPath(sessionId), 'utf-8')) as SessionRecord
  } catch {
    return null
  }
}

async function writeAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  await rename(tmp, file)
}

export interface SessionObservation {
  sessionId: string
  transcriptPath: string
  cwd: string
  repoRoot: string
  remote: string | null
  branch: string | null
  /** Current HEAD. */
  head?: string | null
  /** Record `head` as a commit made during the session (at Stop). */
  recordCommit?: boolean
  openedBeforePr?: boolean
  billing?: Billing
  ended?: boolean
  now?: Date
}

/** Create or extend the record. Idempotent: the same observation twice changes nothing new. */
export async function recordSession(obs: SessionObservation): Promise<SessionRecord> {
  await mkdir(paths.sessions(), { recursive: true, mode: 0o700 })
  const now = (obs.now ?? new Date()).toISOString()
  const existing = await readSession(obs.sessionId)

  const branches = existing?.branches ?? []
  if (obs.branch && !branches.includes(obs.branch)) branches.push(obs.branch)

  const startHead = existing ? existing.startHead : (obs.head ?? undefined)
  const commits = [...(existing?.commits ?? [])]
  if (
    obs.recordCommit &&
    obs.head &&
    obs.branch &&
    obs.head !== startHead &&
    !commits.some(c => c.sha === obs.head && c.branch === obs.branch)
  ) {
    commits.push({ branch: obs.branch, sha: obs.head })
  }
  const openedBeforePr = existing?.openedBeforePr ?? obs.openedBeforePr
  // A later 'unknown' never erases what an earlier hook knew.
  const billing =
    obs.billing && obs.billing !== 'unknown' ? obs.billing : (existing?.billing ?? obs.billing)

  const record: SessionRecord = {
    sessionId: obs.sessionId,
    transcriptPath: obs.transcriptPath || existing?.transcriptPath || '',
    cwd: obs.cwd || existing?.cwd || '',
    repoRoot: obs.repoRoot,
    remote: obs.remote ?? existing?.remote ?? null,
    branches,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    ...(obs.ended ? { endedAt: now } : existing?.endedAt ? { endedAt: existing.endedAt } : {}),
    ...(openedBeforePr !== undefined ? { openedBeforePr } : {}),
    ...(startHead ? { startHead } : {}),
    commits,
    ...(billing ? { billing } : {}),
  }
  await writeAtomic(recordPath(obs.sessionId), record)
  return record
}

export async function listSessions(): Promise<SessionRecord[]> {
  let files: string[]
  try {
    files = await readdir(paths.sessions())
  } catch {
    return []
  }
  const records: SessionRecord[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      records.push(JSON.parse(await readFile(join(paths.sessions(), file), 'utf-8')))
    } catch {
      // Torn or foreign file; skip.
    }
  }
  return records.sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt))
}

/** Sessions that worked on this branch of this repository, oldest first. */
export async function sessionsFor(repoRoot: string, branch: string): Promise<SessionRecord[]> {
  return (await listSessions()).filter(s => s.repoRoot === repoRoot && s.branches.includes(branch))
}

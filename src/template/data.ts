import { isAbsolute, relative, sep } from 'node:path'
import type { SessionStats } from '../metrics/index.js'

/**
 * The machine-readable state of a PR's sessions, appended to every comment after the rendered
 * template:
 *
 *   <!-- sessionstat:data {"v":1,"branch":"…","sessions":[...],"totals":{...}} -->
 *
 * It is the PERSISTED STATE, not just output. Before our comment is updated, its block is read
 * back and merged with the local sessions (local wins, sessions only in the block are kept), and
 * the template is rendered from the merged set - so a comment never loses a session because
 * scratch was wiped or the session ran on another machine.
 *
 * Added by the code, like the marker, so no template can remove or break it. Raw numbers only,
 * never the formatted strings.
 *
 * An HTML comment ends at the first `--`, which can occur inside a JSON string (a branch name, a
 * model id). Every `--` is written as `--`: still the same JSON, never two dashes in a row.
 */

export const DATA_PREFIX = '<!-- sessionstat:data '
const DATA_SUFFIX = ' -->'

export interface DataTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface DataSession {
  id: string
  /** The PR branch this session counts towards. */
  branch: string
  /** gh login of whoever ran the session; null when it was never known. */
  author: string | null
  model: string | null
  startedAt: string
  endedAt: string
  durationMs: number
  /**
   * Did the PR already exist when the session started? True means follow-up work (responding
   * to review); false means the session built the branch.
   */
  openedBeforePr: boolean
  /** HEAD commits first seen on the branch at the end of a turn of this session. */
  commits: string[]
  turns: number
  toolCalls: number
  toolResults: number
  tools: Array<{ name: string; count: number }>
  /** Repository-relative paths edited. Edits outside the repository are not part of the PR. */
  files: string[]
  filesEdited: number
  tokens: DataTokens
  costUsd: number | null
  errors: number
  interruptions: number
  compactions: number
  testRuns: { passed: number; failed: number }
  successRate: number
  processQuality: number
  iterations: number
  linesAdded: number | null
  linesRemoved: number | null
}

export interface DataTotals {
  sessions: number
  durationMs: number
  turns: number
  toolCalls: number
  toolResults: number
  filesEdited: number
  commits: number
  tokens: DataTokens
  /** Sum over sessions that have a cost; null when none has one yet. */
  costUsd: number | null
  /** Some sessions have a cost and some do not yet. */
  costPartial: boolean
  errors: number
  interruptions: number
  compactions: number
  testRuns: { passed: number; failed: number }
  /** guidemode's task success rate, pooled: successful tool results over all of them. */
  successRate: number
}

export interface DataBlock {
  v: 1
  branch: string
  sessions: DataSession[]
  totals: DataTotals
}

/** Repository-relative, or null for a path outside the repository. */
function repoRelative(path: string, repoRoot: string | null): string | null {
  if (!repoRoot) return isAbsolute(path) ? null : path
  const rel = relative(repoRoot, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

export interface SessionContext {
  branch: string
  author: string | null
  repoRoot: string | null
  openedBeforePr: boolean
  commits: string[]
}

export function toDataSession(stats: SessionStats, ctx: SessionContext): DataSession {
  const files = [
    ...new Set(
      stats.filesEdited.map(p => repoRelative(p, ctx.repoRoot)).filter((p): p is string => !!p)
    ),
  ].sort()
  return {
    id: stats.sessionId,
    branch: ctx.branch,
    author: ctx.author,
    model: stats.model,
    startedAt: stats.startedAt.toISOString(),
    endedAt: stats.endedAt.toISOString(),
    durationMs: stats.durationMs,
    openedBeforePr: ctx.openedBeforePr,
    commits: [...ctx.commits],
    turns: stats.turns,
    toolCalls: stats.toolCalls,
    toolResults: stats.toolResults,
    tools: stats.tools.map(t => ({ ...t })),
    files,
    filesEdited: files.length,
    tokens: { ...stats.tokens },
    costUsd: stats.costUsd,
    errors: stats.errors,
    interruptions: stats.interruptions,
    compactions: stats.compactions,
    testRuns: { ...stats.testRuns },
    successRate: stats.successRate,
    processQuality: stats.processQuality,
    iterations: stats.iterations,
    linesAdded: stats.linesAdded,
    linesRemoved: stats.linesRemoved,
  }
}

/**
 * Merge by session id: a session we have locally replaces the block's copy (ours is fresher,
 * computed from the transcript just now); a session only in the block is kept as it was.
 * Ordered by start time, so the comment reads chronologically however it was assembled.
 */
export function mergeSessions(local: DataSession[], remote: DataSession[]): DataSession[] {
  const byId = new Map<string, DataSession>()
  for (const s of remote) byId.set(s.id, s)
  for (const s of local) byId.set(s.id, s)
  return sortSessions([...byId.values()])
}

/**
 * The union of several blocks (several authors' comments). Where two carry the same session,
 * the copy that ran longest - the one written last - wins.
 */
export function unionSessions(lists: DataSession[][]): DataSession[] {
  const byId = new Map<string, DataSession>()
  for (const list of lists) {
    for (const s of list) {
      const seen = byId.get(s.id)
      if (!seen || s.endedAt > seen.endedAt) byId.set(s.id, s)
    }
  }
  return sortSessions([...byId.values()])
}

function sortSessions(sessions: DataSession[]): DataSession[] {
  return sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
}

export function computeTotals(sessions: DataSession[]): DataTotals {
  const sum = (f: (s: DataSession) => number) => sessions.reduce((n, s) => n + f(s), 0)
  const priced = sessions.filter(s => s.costUsd !== null)
  const toolResults = sum(s => s.toolResults)
  const errors = sum(s => s.errors)
  return {
    sessions: sessions.length,
    durationMs: sum(s => s.durationMs),
    turns: sum(s => s.turns),
    toolCalls: sum(s => s.toolCalls),
    toolResults,
    filesEdited: new Set(sessions.flatMap(s => s.files)).size,
    commits: new Set(sessions.flatMap(s => s.commits)).size,
    tokens: {
      input: sum(s => s.tokens.input),
      output: sum(s => s.tokens.output),
      cacheRead: sum(s => s.tokens.cacheRead),
      cacheWrite: sum(s => s.tokens.cacheWrite),
    },
    costUsd: priced.length > 0 ? priced.reduce((n, s) => n + (s.costUsd ?? 0), 0) : null,
    costPartial: priced.length > 0 && priced.length < sessions.length,
    errors,
    interruptions: sum(s => s.interruptions),
    compactions: sum(s => s.compactions),
    testRuns: {
      passed: sum(s => s.testRuns.passed),
      failed: sum(s => s.testRuns.failed),
    },
    successRate: toolResults > 0 ? Math.round(((toolResults - errors) / toolResults) * 100) : 0,
  }
}

export function buildData(sessions: DataSession[], branch: string): DataBlock {
  return { v: 1, branch, sessions, totals: computeTotals(sessions) }
}

export function serializeDataBlock(data: DataBlock): string {
  const json = JSON.stringify(data).replace(/--/g, '-\\u002d')
  return `${DATA_PREFIX}${json}${DATA_SUFFIX}`
}

/** Read the data block back out of a comment body. Null if absent or unreadable. */
export function parseDataBlock(body: string): DataBlock | null {
  const start = body.indexOf(DATA_PREFIX)
  if (start < 0) return null
  const from = start + DATA_PREFIX.length
  const end = body.indexOf(DATA_SUFFIX, from)
  if (end < 0) return null
  try {
    const parsed = JSON.parse(body.slice(from, end)) as DataBlock
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.sessions)) return null
    return parsed
  } catch {
    return null
  }
}

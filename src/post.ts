import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { detectBilling } from './billing.js'
import { type BoardOutcome, syncBoard } from './board/board.js'
import { loadBoardSettings, repoSlug } from './board/settings.js'
import { isEnabledFor, loadConfig } from './config.js'
import {
  type PrLookup,
  type PullRequest,
  createComment,
  currentLogin,
  fetchComments,
  findOurComment,
  findPr,
  updateComment,
} from './gh.js'
import { log } from './log.js'
import { type SessionStats, computeSessionStats } from './metrics/index.js'
import { paths } from './paths.js'
import { prStateFromComments } from './pr-state.js'
import type { CommandRunner } from './runner.js'
import { type SessionRecord, sessionsFor } from './sessions.js'
import {
  type DataSession,
  buildData,
  mergeSessions,
  parseDataBlock,
  toDataSession,
  unionSessions,
} from './template/data.js'
import { type RenderResult, renderComment, resolveTemplate } from './template/render.js'
import { type CommentView, buildView } from './template/view.js'
import { keyFor } from './worker.js'

export interface PostDeps {
  run: CommandRunner
  now?: () => Date
}

export interface BuiltComment {
  view: CommentView
  rendered: RenderResult
  /** The merged set the comment was rendered from. */
  sessions: DataSession[]
  /** The sessions computed from local transcripts. */
  local: DataSession[]
}

/**
 * Was the PR already open when this session started? What SessionStart recorded, if it ran and
 * gh answered; otherwise the session's first message against the PR's creation time.
 */
export function resolveOpenedBeforePr(
  record: Pick<SessionRecord, 'openedBeforePr'>,
  stats: Pick<SessionStats, 'startedAt'>,
  pr: Pick<PullRequest, 'createdAt'> | null
): boolean {
  if (record.openedBeforePr !== undefined) return record.openedBeforePr
  if (!pr?.createdAt) return false
  const created = Date.parse(pr.createdAt)
  return Number.isFinite(created) && stats.startedAt.getTime() >= created
}

/** The recorded sessions on this repo + branch, computed from their transcripts now. */
export async function localSessions(
  repoRoot: string,
  branch: string,
  ctx: { login: string | null; pr: PullRequest | null }
): Promise<DataSession[]> {
  const sessions: DataSession[] = []
  for (const record of await sessionsFor(repoRoot, branch)) {
    let content: string
    try {
      content = await readFile(record.transcriptPath, 'utf-8')
    } catch {
      await log('WARN', `Transcript gone for session ${record.sessionId}: ${record.transcriptPath}`)
      continue
    }
    try {
      const { stats } = await computeSessionStats(content)
      // The record's id is the hook's; the transcript's should match, but the hook is the truth.
      stats.sessionId = record.sessionId
      sessions.push(
        toDataSession(stats, {
          branch,
          author: ctx.login,
          repoRoot,
          openedBeforePr: resolveOpenedBeforePr(record, stats, ctx.pr),
          commits: (record.commits ?? []).filter(c => c.branch === branch).map(c => c.sha),
          billing: record.billing ?? 'unknown',
        })
      )
    } catch (err) {
      await log('ERROR', `Could not parse ${record.transcriptPath}: ${String(err)}`)
    }
  }
  return sessions
}

function repoLabel(remote: string | null | undefined, fallback: string): string {
  const match = remote?.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/)
  return match?.[1] ?? fallback
}

/** Render a set of sessions: the view, the template, the marker and the data block. */
export async function renderSessions(
  sessions: DataSession[],
  ctx: {
    repoRoot: string | null
    branch: string
    pr: PullRequest | null
    remote?: string | null
    now?: Date
  }
): Promise<{ view: CommentView; rendered: RenderResult }> {
  const view = buildView({
    sessions,
    pr: ctx.pr,
    repo: repoLabel(ctx.remote, ctx.repoRoot ?? ''),
    branch: ctx.branch,
    now: ctx.now,
  })
  const rendered = await renderComment(view, ctx.repoRoot, buildData(sessions, ctx.branch))
  return { view, rendered }
}

/**
 * The comment for this repo + branch: local sessions merged over `remote` (sessions already in
 * a comment's data block). Used by `show`, `template vars` and posting alike.
 */
export async function buildComment(
  repoRoot: string,
  branch: string,
  pr: PullRequest | null,
  options: { login?: string | null; remote?: DataSession[]; now?: Date } = {}
): Promise<BuiltComment> {
  const records = await sessionsFor(repoRoot, branch)
  const local = await localSessions(repoRoot, branch, { login: options.login ?? null, pr })
  const sessions = mergeSessions(local, options.remote ?? [])
  const { view, rendered } = await renderSessions(sessions, {
    repoRoot,
    branch,
    pr,
    remote: records.find(r => r.remote)?.remote,
    now: options.now,
  })
  return { view, rendered, sessions, local }
}

/** Render a comment from transcript files directly, with no recorded sessions needed. */
export async function buildCommentFromTranscripts(
  transcriptPaths: string[],
  options: { repoRoot: string | null; branch: string; pr: PullRequest | null; now?: Date }
): Promise<BuiltComment> {
  const local: DataSession[] = []
  // These transcripts ran here, so this machine's billing is the best answer available.
  const billing = await detectBilling()
  for (const path of transcriptPaths) {
    const { stats } = await computeSessionStats(await readFile(path, 'utf-8'))
    local.push(
      toDataSession(stats, {
        branch: options.branch,
        author: null,
        repoRoot: options.repoRoot,
        openedBeforePr: resolveOpenedBeforePr({}, stats, options.pr),
        commits: [],
        billing,
      })
    )
  }
  const sessions = mergeSessions(local, [])
  const { view, rendered } = await renderSessions(sessions, options)
  return { view, rendered, sessions, local }
}

interface PostedState {
  prNumber: number
  commentId: number
  /** Hash of the body last written. */
  hash: string
  /** Hash of the local inputs (local sessions + template) that body was made from. */
  localHash: string
  postedAt: string
}

function postedPath(repoRoot: string, branch: string): string {
  return join(paths.posted(), `${keyFor(repoRoot, branch)}.json`)
}

async function readPosted(repoRoot: string, branch: string): Promise<PostedState | null> {
  try {
    return JSON.parse(await readFile(postedPath(repoRoot, branch), 'utf-8')) as PostedState
  } catch {
    return null
  }
}

async function writePosted(repoRoot: string, branch: string, state: PostedState): Promise<void> {
  await mkdir(paths.posted(), { recursive: true, mode: 0o700 })
  await writeFile(postedPath(repoRoot, branch), JSON.stringify(state, null, 2), { mode: 0o600 })
}

/** The body's identity, data block included, ignoring only the "updated <time>" footer. */
export function contentHash(body: string): string {
  const stable = body.replace(/updated \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g, '')
  return createHash('sha256').update(stable).digest('hex').slice(0, 32)
}

function localInputsHash(local: DataSession[], template: string, prNumber: number): string {
  return createHash('sha256')
    .update(JSON.stringify({ local, template, prNumber }))
    .digest('hex')
    .slice(0, 32)
}

export type PostOutcome =
  | { status: 'disabled' }
  | { status: 'no-sessions' }
  | { status: 'no-pr'; lookup: PrLookup['status'] }
  | { status: 'unchanged'; pr: PullRequest }
  | { status: 'created'; pr: PullRequest; commentId: number; board?: BoardOutcome }
  | { status: 'updated'; pr: PullRequest; commentId: number; board?: BoardOutcome }
  | { status: 'error'; message: string }

/**
 * Post or update this user's one comment for this repo + branch.
 *
 * The comment's data block is the persisted state: before an update it is read back, merged
 * with the local sessions (local wins, block-only sessions are kept) and the whole comment is
 * re-rendered from the merged set.
 *
 * Order matters for cost. Sessions first (local), then the PR and the login (two gh calls),
 * then a check that nothing local has changed since the last write - in which case nothing
 * else happens - and only then the comment listing and the write.
 */
export async function postForBranch(
  repoRoot: string,
  branch: string,
  deps: PostDeps,
  options: { force?: boolean } = {}
): Promise<PostOutcome> {
  const config = await loadConfig()
  if (!isEnabledFor(config, repoRoot)) return { status: 'disabled' }

  const records = await sessionsFor(repoRoot, branch)
  if (records.length === 0) return { status: 'no-sessions' }

  const lookup = await findPr(deps.run, repoRoot, { branch })
  if (lookup.status !== 'found') {
    if (lookup.status === 'not-authenticated' || lookup.status === 'not-installed') {
      await log('ERROR', `gh ${lookup.status} — cannot post for ${repoRoot} ${branch}`)
    } else if (lookup.status === 'error') {
      await log('ERROR', `gh pr view failed for ${repoRoot} ${branch}: ${lookup.message}`)
    }
    return { status: 'no-pr', lookup: lookup.status }
  }
  const pr = lookup.pr

  const me = await currentLogin(deps.run, repoRoot)
  if (!me.ok) {
    await log('ERROR', `Could not read the gh user: ${me.message}`)
    return { status: 'error', message: me.message }
  }

  const local = await localSessions(repoRoot, branch, { login: me.login, pr })
  if (local.length === 0) return { status: 'no-sessions' }

  const template = await resolveTemplate(repoRoot)
  const localHash = localInputsHash(local, template.template, pr.number)
  const previous = await readPosted(repoRoot, branch)
  if (!options.force && previous?.prNumber === pr.number && previous.localHash === localHash) {
    return { status: 'unchanged', pr }
  }

  const comments = await fetchComments(deps.run, repoRoot, pr.number)
  if (!comments.ok) {
    await log('ERROR', `Listing comments on #${pr.number} failed: ${comments.message}`)
    return { status: 'error', message: comments.message }
  }
  const ours = findOurComment(comments.output, me.login)
  const remote = ours ? (parseDataBlock(ours.body)?.sessions ?? []) : []

  const sessions = mergeSessions(local, remote)
  const { rendered } = await renderSessions(sessions, {
    repoRoot,
    branch,
    pr,
    remote: records.find(r => r.remote)?.remote,
    now: deps.now?.(),
  })
  const hash = contentHash(rendered.body)
  const now = (deps.now?.() ?? new Date()).toISOString()
  const remember = (commentId: number) =>
    writePosted(repoRoot, branch, {
      prNumber: pr.number,
      commentId,
      hash,
      localHash,
      postedAt: now,
    })

  if (ours) {
    if (!options.force && contentHash(ours.body) === hash) {
      await remember(ours.id)
      return { status: 'unchanged', pr }
    }
    const updated = await updateComment(deps.run, repoRoot, ours.id, rendered.body)
    if (!updated.ok) {
      await log('ERROR', `Updating comment on #${pr.number} failed: ${updated.message}`)
      return { status: 'error', message: updated.message }
    }
    await remember(ours.id)
    await log('INFO', `Updated comment ${ours.id} on ${pr.url} (${sessions.length} sessions)`)
    const board = await updateBoard(deps, repoRoot, records, pr, sessions, comments.output)
    return { status: 'updated', pr, commentId: ours.id, ...(board ? { board } : {}) }
  }

  const created = await createComment(deps.run, repoRoot, pr.number, rendered.body)
  if (!created.ok) {
    await log('ERROR', `Creating comment on #${pr.number} failed: ${created.message}`)
    return { status: 'error', message: created.message }
  }
  await remember(created.id)
  await log('INFO', `Created comment ${created.id} on ${pr.url}`)
  const board = await updateBoard(deps, repoRoot, records, pr, sessions, comments.output)
  return { status: 'created', pr, commentId: created.id, ...(board ? { board } : {}) }
}

/**
 * After a comment is written, mirror the PR's totals onto the repository's project board, if
 * it has one. The totals are over every author's sessions: this comment's plus the data block
 * of every other sessionstat comment on the PR. A board failure is logged and never undoes or
 * blocks the comment.
 */
async function updateBoard(
  deps: PostDeps,
  repoRoot: string,
  records: SessionRecord[],
  pr: PullRequest,
  sessions: DataSession[],
  commentsOutput: string
): Promise<BoardOutcome | undefined> {
  const slug = repoSlug(records.find(r => r.remote)?.remote)
  if (!slug) return undefined
  const settings = await loadBoardSettings(repoRoot, slug)
  if (!settings) return undefined
  if (!pr.id) {
    await log('WARN', `No node id for ${pr.url}; cannot add it to the project board`)
    return { status: 'error', message: 'gh pr view returned no PR id' }
  }
  let outcome: BoardOutcome
  try {
    const all = unionSessions([sessions, prStateFromComments(commentsOutput).sessions])
    outcome = await syncBoard(deps.run, repoRoot, {
      slug,
      board: settings.board,
      pr: { id: pr.id, number: pr.number },
      sessions: all,
      now: deps.now?.(),
    })
  } catch (err) {
    outcome = { status: 'error', message: String(err) }
  }
  if (outcome.status === 'error') {
    await log('ERROR', `Project board for ${slug} #${pr.number}: ${outcome.message}`)
  } else if (outcome.status === 'updated') {
    await log('INFO', `Project board ${outcome.url}: #${pr.number} ${outcome.written.join(', ')}`)
  }
  return outcome
}

import type { CommandRunner } from './runner.js'

/** Every comment sessionstat writes starts with this, and it is how we find ours again. */
export const MARKER = '<!-- sessionstat -->'

export interface PullRequest {
  /** GraphQL node id, for adding the PR to a project board. */
  id?: string
  number: number
  url: string
  headRefName: string
  state?: string
  createdAt?: string
}

export type PrLookup =
  | { status: 'found'; pr: PullRequest }
  | { status: 'none' }
  | { status: 'not-installed' }
  | { status: 'not-authenticated' }
  | { status: 'timeout' }
  | { status: 'error'; message: string }

const GH_TIMEOUT = 20_000

/**
 * The open PR whose head is the branch checked out in `cwd`.
 *
 * `gh pr view` with no argument resolves the current branch itself, including a branch pushed
 * to a fork, which is why it is used rather than a search by branch name.
 */
export async function findPr(
  run: CommandRunner,
  cwd: string,
  options: { timeoutMs?: number; branch?: string; anyState?: boolean } = {}
): Promise<PrLookup> {
  const args = ['pr', 'view']
  if (options.branch) args.push(options.branch)
  args.push('--json', 'id,number,url,headRefName,state,createdAt')
  const result = await run('gh', args, { cwd, timeoutMs: options.timeoutMs ?? GH_TIMEOUT })
  return interpretPrView(result, options)
}

export function interpretPrView(
  result: {
    code: number
    stdout: string
    stderr: string
    notFound?: boolean
    timedOut?: boolean
  },
  options: { anyState?: boolean } = {}
): PrLookup {
  if (result.notFound) return { status: 'not-installed' }
  if (result.timedOut) return { status: 'timeout' }
  if (result.code !== 0) {
    const err = result.stderr.toLowerCase()
    if (err.includes('gh auth login') || err.includes('not logged in')) {
      return { status: 'not-authenticated' }
    }
    if (err.includes('no pull requests found') || err.includes('no open pull requests')) {
      return { status: 'none' }
    }
    return { status: 'error', message: result.stderr.trim().split('\n')[0] ?? 'gh failed' }
  }
  try {
    const pr = JSON.parse(result.stdout) as PullRequest
    if (typeof pr.number !== 'number' || typeof pr.url !== 'string') {
      return { status: 'error', message: 'unexpected gh pr view output' }
    }
    // A merged or closed PR for the branch is not somewhere to keep posting. (A board resync
    // reads one, though: its comments are still the record of its sessions.)
    if (!options.anyState && pr.state && pr.state !== 'OPEN') return { status: 'none' }
    return { status: 'found', pr }
  } catch {
    return { status: 'error', message: 'gh pr view returned invalid JSON' }
  }
}

export interface IssueComment {
  id: number
  body: string
  user?: { login?: string } | null
}

/**
 * Pick our comment out of `gh api .../comments` output: the first with the marker that was
 * written by `login`, the current `gh` user.
 *
 * Authorship matters because GitHub will not let us PATCH someone else's comment: a second
 * contributor posting stats on the same PR gets a comment of their own instead of a 403.
 *
 * Accepts a flat array (one page), `--slurp` output (an array of pages) or concatenated pages
 * (`[...][...]`, what `--paginate` alone prints). If somehow there are several, the first wins
 * so we keep editing the same one.
 */
export function findOurComment(apiOutput: string, login: string): IssueComment | null {
  const me = login.toLowerCase()
  for (const comment of parseCommentPages(apiOutput)) {
    if (typeof comment?.body !== 'string' || !comment.body.includes(MARKER)) continue
    if (comment.user?.login?.toLowerCase() !== me) continue
    return { id: comment.id, body: comment.body, user: comment.user }
  }
  return null
}

/** The login `gh` is authenticated as. */
export async function currentLogin(
  run: CommandRunner,
  cwd: string
): Promise<{ ok: true; login: string } | { ok: false; message: string }> {
  const result = await run('gh', ['api', 'user', '--jq', '.login'], { cwd, timeoutMs: GH_TIMEOUT })
  const login = result.stdout.trim()
  if (result.code !== 0 || !login) {
    return { ok: false, message: result.stderr.trim() || 'could not read the gh user' }
  }
  return { ok: true, login }
}

function parseCommentPages(output: string): IssueComment[] {
  const trimmed = output.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // `--paginate` without `--slurp` concatenates arrays: `[...][...]`.
    try {
      parsed = JSON.parse(`[${trimmed.replace(/\]\s*\[/g, '],[')}]`)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flat() as IssueComment[]
}

/** Every comment on the PR, raw (`gh api --paginate` output). */
export async function fetchComments(
  run: CommandRunner,
  cwd: string,
  prNumber: number
): Promise<{ ok: true; output: string } | { ok: false; message: string }> {
  const result = await run(
    'gh',
    ['api', '--paginate', `repos/{owner}/{repo}/issues/${prNumber}/comments?per_page=100`],
    { cwd, timeoutMs: GH_TIMEOUT }
  )
  if (result.code !== 0) return { ok: false, message: result.stderr.trim() || 'gh api failed' }
  return { ok: true, output: result.stdout }
}

/** Every comment carrying the marker, whoever wrote it. */
export function markedComments(apiOutput: string): IssueComment[] {
  return parseCommentPages(apiOutput).filter(
    c => typeof c?.body === 'string' && c.body.includes(MARKER)
  )
}

export async function createComment(
  run: CommandRunner,
  cwd: string,
  prNumber: number,
  body: string
): Promise<{ ok: true; id: number } | { ok: false; message: string }> {
  const result = await run(
    'gh',
    ['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${prNumber}/comments`, '--input', '-'],
    { cwd, timeoutMs: GH_TIMEOUT, input: JSON.stringify({ body }) }
  )
  if (result.code !== 0) return { ok: false, message: result.stderr.trim() || 'gh api failed' }
  try {
    return { ok: true, id: (JSON.parse(result.stdout) as { id: number }).id }
  } catch {
    return { ok: true, id: -1 }
  }
}

export async function updateComment(
  run: CommandRunner,
  cwd: string,
  commentId: number,
  body: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await run(
    'gh',
    ['api', '-X', 'PATCH', `repos/{owner}/{repo}/issues/comments/${commentId}`, '--input', '-'],
    { cwd, timeoutMs: GH_TIMEOUT, input: JSON.stringify({ body }) }
  )
  if (result.code !== 0) return { ok: false, message: result.stderr.trim() || 'gh api failed' }
  return { ok: true }
}

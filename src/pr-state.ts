import { fetchComments, markedComments } from './gh.js'
import type { CommandRunner } from './runner.js'
import { type DataSession, parseDataBlock, unionSessions } from './template/data.js'

/**
 * Everything known about a PR's sessions, from every sessionstat comment on it, whoever wrote
 * it: the union of their data blocks by session id. `sessionstat show --all` uses it; it is also
 * the read side for anything building on the comments (a project board, say).
 */
export interface PrState {
  sessions: DataSession[]
  /** Logins whose comments carried a readable data block. */
  authors: string[]
}

export function prStateFromComments(apiOutput: string): PrState {
  const lists: DataSession[][] = []
  const authors = new Set<string>()
  for (const comment of markedComments(apiOutput)) {
    const block = parseDataBlock(comment.body)
    if (!block) continue
    lists.push(block.sessions)
    if (comment.user?.login) authors.add(comment.user.login)
  }
  return { sessions: unionSessions(lists), authors: [...authors].sort() }
}

export async function readPrState(
  run: CommandRunner,
  cwd: string,
  pr: { number: number }
): Promise<{ ok: true; state: PrState } | { ok: false; message: string }> {
  const comments = await fetchComments(run, cwd, pr.number)
  if (!comments.ok) return comments
  return { ok: true, state: prStateFromComments(comments.output) }
}

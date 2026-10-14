import { type SessionstatConfig, isEnabledFor, loadConfig } from './config.js'
import { type PrLookup, findPr } from './gh.js'
import { type GitMetadata, getGitMetadata, isGitHubRemote } from './git.js'
import type { CommandRunner } from './runner.js'

/**
 * The start-of-session notice, after guidemode's `session-start.ts`: one line of JSON on stdout,
 * `{"systemMessage": "..."}`, which Claude Code shows the user before the first prompt.
 *
 * It must stay fast, so the one network call (`gh pr view`) gets a short timeout, and a timeout
 * falls back to the generic line rather than holding up the session.
 */
export const NOTICE_GH_TIMEOUT_MS = 1500

/** The SessionStart PR lookup, or null where sessionstat has nothing to say or do. */
export async function startLookup(
  meta: GitMetadata,
  config: SessionstatConfig,
  run: CommandRunner,
  timeoutMs: number = NOTICE_GH_TIMEOUT_MS
): Promise<PrLookup | null> {
  if (!meta.toplevel || !isGitHubRemote(meta.remoteUrl) || !meta.branch) return null
  if (!isEnabledFor(config, meta.toplevel)) return null
  return findPr(run, meta.toplevel, { timeoutMs })
}

/** The line to show for a lookup. Null when the notice is off or there is nothing to say. */
export function noticeText(
  lookup: PrLookup | null,
  meta: GitMetadata,
  config: SessionstatConfig
): string | null {
  if (config.notice === false) return null
  // A git repository with no GitHub remote: say why nothing will be posted, rather than staying
  // silent and leaving the user to wonder whether sessionstat is installed at all.
  if (meta.toplevel && isEnabledFor(config, meta.toplevel) && !isGitHubRemote(meta.remoteUrl)) {
    return meta.remoteUrl
      ? "sessionstat: stats for this session won't be posted: this repository's remote is not on GitHub"
      : "sessionstat: stats for this session won't be posted until this repository has a GitHub remote"
  }
  const branch = meta.branch
  if (!lookup || !branch) return null
  switch (lookup.status) {
    case 'found':
      return `sessionstat: stats for this session will be added to PR #${lookup.pr.number} for ${branch} (${lookup.pr.url})`
    case 'not-authenticated':
      return `sessionstat: stats for this session won't be posted: run \`gh auth login\``
    case 'not-installed':
      return `sessionstat: stats for this session won't be posted: install the GitHub CLI (\`brew install gh\`), then run \`gh auth login\``
    default:
      return `sessionstat: stats for this session will be added to the PR for ${branch}`
  }
}

/** Lookup and text together, for callers that have only a directory. */
export async function noticeFor(
  cwd: string,
  run: CommandRunner,
  timeoutMs: number = NOTICE_GH_TIMEOUT_MS
): Promise<string | null> {
  const config = await loadConfig()
  if (config.notice === false) return null
  const meta = await getGitMetadata(cwd, run)
  return noticeText(await startLookup(meta, config, run, timeoutMs), meta, config)
}

/**
 * The JSON Claude Code reads from a SessionStart hook's stdout. Claude Code shows it after
 * "SessionStart:startup says:", so a leading newline puts the notice on a line of its own.
 */
export function noticeJson(line: string): string {
  return `${JSON.stringify({ systemMessage: `\n${line}` })}\n`
}

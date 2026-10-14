import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Every location sessionstat reads or writes. Functions, not constants, so a test can point
 * HOME (or SESSIONSTAT_HOME) at a temp directory and nothing real is touched.
 */

export function home(): string {
  return process.env.HOME || homedir()
}

/** Scratch, queue, logs and config. Shared by every install scope. */
export function stateDir(): string {
  return process.env.SESSIONSTAT_HOME || join(home(), '.sessionstat')
}

export const paths = {
  sessions: () => join(stateDir(), 'sessions'),
  prChecks: () => join(stateDir(), 'pr-checks'),
  posted: () => join(stateDir(), 'posted'),
  locks: () => join(stateDir(), 'locks'),
  dedupe: () => join(stateDir(), 'dedupe'),
  pollerLock: () => join(stateDir(), 'locks', 'poller.lock'),
  logFile: () => join(stateDir(), 'sessionstat.log'),
  config: () => join(stateDir(), 'config.json'),
  /** Project, field and item ids for each repository's board, and the values last written. */
  boardCache: () => join(stateDir(), 'board-cache.json'),
  homeTemplate: () => join(stateDir(), 'template.md'),
  claudeDir: () => join(home(), '.claude'),
  /** User scope. Claude Code has no user-level `settings.local.json` in its precedence chain. */
  userSettings: () => join(home(), '.claude', 'settings.json'),
  /** Not read by Claude Code at user level, so any hooks there are dead; setup cleans them up. */
  legacyUserSettings: () => join(home(), '.claude', 'settings.local.json'),
  skillDir: () => join(home(), '.claude', 'skills', 'sessionstat'),
  skillFile: () => join(home(), '.claude', 'skills', 'sessionstat', 'SKILL.md'),
}

/** Project scope: the same file guidemode's `projectHooksPath` uses. */
export function projectSettingsPath(repoRoot: string): string {
  return join(repoRoot, '.claude', 'settings.local.json')
}

export function repoTemplatePath(repoRoot: string): string {
  return join(repoRoot, '.sessionstat.md')
}

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadConfig, updateConfig } from '../config.js'
import { DEFAULT_PREFIX } from './fields.js'

/**
 * Which Projects v2 board a repository's PRs go on. One board per repository.
 *
 * Kept under `boards` in `~/.sessionstat/config.json`, keyed by `owner/repo`. A team can share
 * it in `<repo>/.claude/sessionstat.json` (or the older `<repo>/.sessionstat.json`), but that
 * file arrives with whatever branch is checked out, so it is only a proposal: it is used once
 * the same board is in the user's own config.json, which `sessionstat board setup` asks before
 * writing. Until then the user's own setting, if any, is used.
 */
export interface BoardSettings {
  /** The login of the user or organisation that owns the project. */
  owner: string
  number: number
  url?: string
  /** Default `Agent `. */
  prefix?: string
  /** Field keys to keep (see `FIELDS`); all of them when absent. */
  fields?: string[]
}

interface RepoFile {
  board?: BoardSettings
  [key: string]: unknown
}

export function repoSettingsPath(repoRoot: string): string {
  return join(repoRoot, '.claude', 'sessionstat.json')
}

/** Where older versions saved it; still read, never written. */
export function legacyRepoSettingsPath(repoRoot: string): string {
  return join(repoRoot, '.sessionstat.json')
}

async function readRepoFile(path: string): Promise<RepoFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as RepoFile) : {}
  } catch {
    return {}
  }
}

function valid(board: unknown): board is BoardSettings {
  const b = board as BoardSettings | undefined
  return !!b && typeof b.owner === 'string' && typeof b.number === 'number'
}

/** The board the repository's own file names, trusted or not. */
export async function loadSharedBoard(
  repoRoot: string
): Promise<{ board: BoardSettings; source: string } | null> {
  for (const path of [repoSettingsPath(repoRoot), legacyRepoSettingsPath(repoRoot)]) {
    const file = await readRepoFile(path)
    if (valid(file.board)) return { board: file.board, source: path }
  }
  return null
}

/**
 * Whether two settings write to the same fields of the same project. `fields` can only leave
 * fields out, so it may differ.
 */
export function sameBoard(a: BoardSettings, b: BoardSettings): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.number === b.number &&
    (a.prefix ?? DEFAULT_PREFIX) === (b.prefix ?? DEFAULT_PREFIX)
  )
}

/**
 * The board to write to: the repository's shared one if the user has accepted it (it matches
 * their config.json), else their own. `pending` is a shared board they have not accepted.
 */
export async function loadBoardSettings(
  repoRoot: string,
  slug: string | null
): Promise<{ board: BoardSettings; source: string; pending?: BoardSettings } | null> {
  if (!slug) return null
  const shared = await loadSharedBoard(repoRoot)
  const own = (await loadConfig()).boards?.[slug]
  if (!valid(own)) return null
  if (shared && sameBoard(shared.board, own)) return shared
  return {
    board: own,
    source: `config.json boards["${slug}"]`,
    ...(shared ? { pending: shared.board } : {}),
  }
}

/**
 * A shared board the user has not accepted, so nothing is written to it yet.
 */
export async function pendingSharedBoard(
  repoRoot: string,
  slug: string | null
): Promise<{ board: BoardSettings; source: string } | null> {
  const shared = await loadSharedBoard(repoRoot)
  if (!shared) return null
  const own = slug ? (await loadConfig()).boards?.[slug] : undefined
  return valid(own) && sameBoard(shared.board, own) ? null : shared
}

/**
 * Save to config.json, and also to the shared repository file when `repoRoot` is given (the
 * config.json copy is what makes the shared one trusted here). Other keys are kept.
 */
export async function saveBoardSettings(
  where: { slug: string; repoRoot?: string },
  board: BoardSettings
): Promise<string> {
  const config = await loadConfig()
  await updateConfig({ boards: { ...(config.boards ?? {}), [where.slug]: board } })
  if (where.repoRoot) {
    const path = repoSettingsPath(where.repoRoot)
    const file = await readRepoFile(path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ ...file, board }, null, 2)}\n`)
    return path
  }
  return `config.json boards["${where.slug}"]`
}

/** `https://github.com/orgs/acme/projects/7` or `…/users/alice/projects/3`. */
export function parseProjectUrl(url: string): { owner: string; number: number } | null {
  const match = url.trim().match(/github\.com\/(?:orgs|users)\/([^/]+)\/projects\/(\d+)/)
  return match ? { owner: match[1], number: Number(match[2]) } : null
}

/** `owner/repo` from a GitHub remote URL. */
export function repoSlug(remote: string | null | undefined): string | null {
  return remote?.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1] ?? null
}

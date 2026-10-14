import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig, updateConfig } from '../config.js'

/**
 * Which Projects v2 board a repository's PRs go on. One board per repository.
 *
 * Kept in `<repo>/.sessionstat.json` for a per-repository install (next to `.sessionstat.md`,
 * and like it can be committed so the team shares the board), or under `boards` in
 * `~/.sessionstat/config.json`, keyed by `owner/repo`, for a global one. The repository file
 * wins.
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
  return join(repoRoot, '.sessionstat.json')
}

async function readRepoFile(repoRoot: string): Promise<RepoFile> {
  try {
    const parsed = JSON.parse(await readFile(repoSettingsPath(repoRoot), 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as RepoFile) : {}
  } catch {
    return {}
  }
}

function valid(board: unknown): board is BoardSettings {
  const b = board as BoardSettings | undefined
  return !!b && typeof b.owner === 'string' && typeof b.number === 'number'
}

export async function loadBoardSettings(
  repoRoot: string,
  slug: string | null
): Promise<{ board: BoardSettings; source: string } | null> {
  const file = await readRepoFile(repoRoot)
  if (valid(file.board)) return { board: file.board, source: repoSettingsPath(repoRoot) }
  if (!slug) return null
  const config = await loadConfig()
  const board = config.boards?.[slug]
  return valid(board) ? { board, source: `config.json boards["${slug}"]` } : null
}

/** Save to the repository file, or to config.json for a global install. Other keys are kept. */
export async function saveBoardSettings(
  where: { repoRoot: string } | { slug: string },
  board: BoardSettings
): Promise<string> {
  if ('repoRoot' in where) {
    const file = await readRepoFile(where.repoRoot)
    const path = repoSettingsPath(where.repoRoot)
    await writeFile(path, `${JSON.stringify({ ...file, board }, null, 2)}\n`)
    return path
  }
  const config = await loadConfig()
  await updateConfig({ boards: { ...(config.boards ?? {}), [where.slug]: board } })
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

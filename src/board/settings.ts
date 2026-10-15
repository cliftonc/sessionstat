import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadConfig, updateConfig } from '../config.js'

/**
 * Which Projects v2 board a repository's PRs go on. One board per repository.
 *
 * Kept under `boards` in `~/.sessionstat/config.json`, keyed by `owner/repo`, unless the team
 * shares it: then in `<repo>/.claude/sessionstat.json`, to be committed. The repository file
 * (or the older `<repo>/.sessionstat.json`) wins.
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

export async function loadBoardSettings(
  repoRoot: string,
  slug: string | null
): Promise<{ board: BoardSettings; source: string } | null> {
  for (const path of [repoSettingsPath(repoRoot), legacyRepoSettingsPath(repoRoot)]) {
    const file = await readRepoFile(path)
    if (valid(file.board)) return { board: file.board, source: path }
  }
  if (!slug) return null
  const config = await loadConfig()
  const board = config.boards?.[slug]
  return valid(board) ? { board, source: `config.json boards["${slug}"]` } : null
}

/** Save to the shared repository file, or to config.json. Other keys are kept. */
export async function saveBoardSettings(
  where: { repoRoot: string } | { slug: string },
  board: BoardSettings
): Promise<string> {
  if ('repoRoot' in where) {
    const path = repoSettingsPath(where.repoRoot)
    const file = await readRepoFile(path)
    await mkdir(dirname(path), { recursive: true })
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

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BoardSettings } from './board/settings.js'
import { paths } from './paths.js'

export interface SessionstatConfig {
  /** Show the start-of-session notice. Default true. */
  notice?: boolean
  /** Turn sessionstat off everywhere without uninstalling. Default true. */
  enabled?: boolean
  /** Repositories (absolute roots) where sessionstat is off. */
  disabledRepos?: string[]
  /** Repositories that have a project-scope install, so `status` and `uninstall` can find them. */
  projectInstalls?: string[]
  /** Projects v2 boards by `owner/repo`, for repositories without a `.sessionstat.json`. */
  boards?: Record<string, BoardSettings>
}

export async function loadConfig(): Promise<SessionstatConfig> {
  try {
    const parsed = JSON.parse(await readFile(paths.config(), 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as SessionstatConfig) : {}
  } catch {
    return {}
  }
}

export async function saveConfig(config: SessionstatConfig): Promise<void> {
  await mkdir(dirname(paths.config()), { recursive: true, mode: 0o700 })
  await writeFile(paths.config(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

export async function updateConfig(patch: Partial<SessionstatConfig>): Promise<SessionstatConfig> {
  const next = { ...(await loadConfig()), ...patch }
  await saveConfig(next)
  return next
}

export function isEnabledFor(config: SessionstatConfig, repoRoot: string | null): boolean {
  if (config.enabled === false) return false
  if (repoRoot && config.disabledRepos?.includes(repoRoot)) return false
  return true
}

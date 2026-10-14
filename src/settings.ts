import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Reading and writing Claude Code settings files, and merging our hooks into them.
 *
 * Copied from guidemode `packages/cli/src/setup.ts` (the Claude Code half): `readSettings`
 * refuses to overwrite a file it cannot parse, `writeSettings` writes through a temp file,
 * `installHooks` drops any previous entry of ours and re-adds the current one (idempotent, and
 * lets a changed command or timeout propagate), `removeHooks` leaves everyone else's alone.
 */

export type HookEntry = Record<string, unknown>
export type Settings = Record<string, unknown>

/** The events sessionstat listens on. PostToolUse only for Bash: a `git push` / `gh pr create`. */
export function hooksConfig(command: string): Record<string, HookEntry[]> {
  const hook = (timeout: number) => ({ type: 'command', command, timeout })
  return {
    // Shorter ceiling: it is the one hook that waits on the network (the notice's PR lookup).
    SessionStart: [{ hooks: [hook(5)] }],
    Stop: [{ hooks: [hook(10)] }],
    PostToolUse: [{ matcher: 'Bash', hooks: [hook(10)] }],
    SessionEnd: [{ hooks: [hook(10)] }],
  }
}

export const HOOK_EVENTS = Object.keys(hooksConfig('x'))

/**
 * Is this hook command one of ours? Matched on the `sessionstat ... hook` shape rather than a
 * bare substring, so a user's own `sessionstat show` hook survives a re-run of setup.
 */
export function isSessionstatCommand(command: unknown): boolean {
  return (
    typeof command === 'string' && /sessionstat/.test(command) && /(^|\s)hook\s*$/.test(command)
  )
}

export function hasSessionstatHook(entry: HookEntry): boolean {
  if (Array.isArray(entry.hooks)) {
    return entry.hooks.some((h: Record<string, unknown>) => isSessionstatCommand(h?.command))
  }
  return isSessionstatCommand(entry.command)
}

/** Read a settings file: null when absent, throws when present but not JSON. */
export async function readSettings(path: string): Promise<Settings | null> {
  let content: string
  try {
    content = await readFile(path, 'utf-8')
  } catch {
    return null
  }
  if (!content.trim()) return {}
  try {
    return JSON.parse(content) as Settings
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Fix or move it, then re-run — refusing to overwrite it.`
    )
  }
}

export async function writeSettings(path: string, settings: Settings): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, path)
}

export async function installHooks(targetPath: string, command: string): Promise<void> {
  const settings = (await readSettings(targetPath)) ?? {}
  const existingHooks = (settings.hooks || {}) as Record<string, HookEntry[]>
  const newHooks = { ...existingHooks }

  for (const [event, newEntries] of Object.entries(hooksConfig(command))) {
    const existing = (existingHooks[event] || []) as HookEntry[]
    const others = existing.filter(entry => !hasSessionstatHook(entry))
    newHooks[event] = [...others, ...newEntries]
  }

  settings.hooks = newHooks
  await writeSettings(targetPath, settings)
}

/** Strip our hooks, leaving everyone else's. Returns true if anything was removed. */
export async function removeHooks(targetPath: string): Promise<boolean> {
  const settings = await readSettings(targetPath)
  if (!settings?.hooks) return false

  const existingHooks = settings.hooks as Record<string, HookEntry[]>
  const remaining: Record<string, HookEntry[]> = {}
  let removed = false

  for (const [event, entries] of Object.entries(existingHooks)) {
    const list = (entries || []) as HookEntry[]
    const others = list.filter(entry => !hasSessionstatHook(entry))
    if (others.length !== list.length) removed = true
    if (others.length > 0) remaining[event] = others
  }

  if (!removed) return false
  settings.hooks = Object.keys(remaining).length > 0 ? remaining : undefined
  await writeSettings(targetPath, settings)
  return true
}

/** Which of our events a settings file has a sessionstat hook on. Never throws. */
export async function installedEvents(path: string): Promise<string[]> {
  try {
    const settings = await readSettings(path)
    const hooks = (settings?.hooks ?? {}) as Record<string, HookEntry[]>
    return Object.entries(hooks)
      .filter(([, entries]) => Array.isArray(entries) && entries.some(hasSessionstatHook))
      .map(([event]) => event)
  } catch {
    return []
  }
}

export async function hasHooksInstalled(path: string): Promise<boolean> {
  return (await installedEvents(path)).length > 0
}

/** Settings with our hooks taken out: what must be unchanged by an install. */
export function withoutOurs(settings: Settings | null): Settings {
  const copy = { ...(settings ?? {}) }
  const hooks = (copy.hooks ?? {}) as Record<string, HookEntry[]>
  const others: Record<string, HookEntry[]> = {}
  for (const [event, entries] of Object.entries(hooks)) {
    const kept = (entries ?? []).filter(entry => !hasSessionstatHook(entry))
    if (kept.length > 0) others[event] = kept
  }
  copy.hooks = Object.keys(others).length > 0 ? others : undefined
  return JSON.parse(JSON.stringify(copy)) as Settings
}

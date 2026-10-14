import { constants, access, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { loadConfig, updateConfig } from './config.js'
import { paths, projectSettingsPath, repoTemplatePath } from './paths.js'
import type { CommandRunner } from './runner.js'
import {
  HOOK_EVENTS,
  hasHooksInstalled,
  installHooks,
  installedEvents,
  readSettings,
  removeHooks,
  withoutOurs,
} from './settings.js'
import { installSkill } from './skill.js'
import { DEFAULT_TEMPLATE } from './template/render.js'

export interface CheckLine {
  ok: boolean
  /** A warning: worth reading, not a failure. */
  warn?: boolean
  label: string
  detail?: string
  fix?: string
}

export interface SetupDeps {
  run: CommandRunner
  out: (line: string) => void
  version: string
  /** The CLI entry point, for the fallback hook command. Defaults to `process.argv[1]`. */
  entry?: string
  nodePath?: string
  cwd?: string
}

export interface SetupOptions {
  /** `true` for the current directory's repository, or a path inside the repository. */
  project?: string | boolean
}

export interface SetupResult {
  ok: boolean
  checks: CheckLine[]
  settingsPath: string
  templatePath: string
  hookCommand: string
}

/** Quote for a POSIX shell, but only when needed, so the common case reads naturally. */
export function shellQuote(value: string): string {
  return /^[\w/.@+:,=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * The command the hooks will run, as an absolute path so it works whatever PATH Claude Code
 * gives its hooks (nvm, volta and friends often leave the global bin out).
 *
 * Prefers the `sessionstat` on PATH (the installed bin); falls back to node + this script.
 */
export async function resolveHookCommand(
  deps: Pick<SetupDeps, 'run' | 'entry' | 'nodePath'>
): Promise<{ command: string; ok: boolean; detail: string }> {
  const which = await deps.run('which', ['sessionstat'], { timeoutMs: 5000 })
  const onPath = which.code === 0 ? which.stdout.trim().split('\n')[0] : ''
  if (onPath && (await isExecutable(onPath))) {
    return { command: `${shellQuote(onPath)} hook`, ok: true, detail: onPath }
  }

  const entry = deps.entry ?? process.argv[1]
  const node = deps.nodePath ?? process.execPath
  if (entry && (await exists(entry))) {
    const script = await realpath(entry)
    return {
      command: `${shellQuote(node)} ${shellQuote(script)} hook`,
      ok: true,
      detail: `${script} (not on PATH; using node directly)`,
    }
  }
  return { command: 'sessionstat hook', ok: false, detail: 'sessionstat is not on PATH' }
}

async function repoRootOf(run: CommandRunner, dir: string): Promise<string | null> {
  const result = await run('git', ['rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 5000 })
  return result.code === 0 ? result.stdout.trim() : null
}

/** Copy the default template to `path` unless something is already there. Never overwrites. */
export async function copyTemplateIfAbsent(path: string): Promise<boolean> {
  if (await exists(path)) return false
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, DEFAULT_TEMPLATE, { flag: 'wx' })
  return true
}

/**
 * Remove our hooks from locations that are dead or that would double up with the one just
 * installed. Adapted from guidemode's `cleanupStaleHookLocations`: only places Claude Code would
 * never read (the user-level `settings.local.json`) or the same repository's other settings
 * file. A live install in the OTHER scope is warned about, not removed — it is the user's.
 */
export async function cleanupStaleHookLocations(
  installedPath: string,
  repoRoot: string | null
): Promise<string[]> {
  const candidates = new Set<string>([paths.legacyUserSettings()])
  if (repoRoot) candidates.add(join(repoRoot, '.claude', 'settings.json'))
  candidates.delete(installedPath)
  const cleaned: string[] = []
  for (const path of candidates) {
    try {
      if (await removeHooks(path)) cleaned.push(path)
    } catch {
      // A settings file we cannot parse is not ours to repair.
    }
  }
  return cleaned
}

/** Every project-scope settings file that has our hooks, from config plus the given repo. */
export async function projectInstallsWithHooks(extraRepo?: string | null): Promise<string[]> {
  const config = await loadConfig()
  const repos = new Set(config.projectInstalls ?? [])
  if (extraRepo) repos.add(extraRepo)
  const found: string[] = []
  for (const repo of repos) {
    if (await hasHooksInstalled(projectSettingsPath(repo))) found.push(repo)
  }
  return found
}

export async function runSetup(options: SetupOptions, deps: SetupDeps): Promise<SetupResult> {
  const checks: CheckLine[] = []
  const cwd = deps.cwd ?? process.cwd()
  const out = deps.out

  // ── Tools ────────────────────────────────────────────────────────────────
  const git = await deps.run('git', ['--version'], { timeoutMs: 5000 })
  checks.push(
    git.code === 0
      ? { ok: true, label: 'git is installed', detail: git.stdout.trim() }
      : {
          ok: false,
          label: 'git is not on PATH',
          fix: 'Install git (xcode-select --install, or your package manager)',
        }
  )

  const ghVersion = await deps.run('gh', ['--version'], { timeoutMs: 5000 })
  const ghInstalled = ghVersion.code === 0
  checks.push(
    ghInstalled
      ? { ok: true, label: 'GitHub CLI (gh) is installed', detail: ghVersion.stdout.split('\n')[0] }
      : { ok: false, label: 'GitHub CLI (gh) is not installed', fix: 'brew install gh' }
  )
  if (ghInstalled) {
    const auth = await deps.run('gh', ['auth', 'status'], { timeoutMs: 15000 })
    checks.push(
      auth.code === 0
        ? { ok: true, label: 'gh is logged in' }
        : { ok: false, label: 'gh is not logged in', fix: 'gh auth login' }
    )
  } else {
    checks.push({ ok: false, label: 'gh login not checked (gh missing)', fix: 'gh auth login' })
  }

  // ── Hook command ─────────────────────────────────────────────────────────
  const hook = await resolveHookCommand(deps)
  checks.push(
    hook.ok
      ? { ok: true, label: 'Hook command resolves', detail: hook.detail }
      : {
          ok: false,
          label: 'Hook command does not resolve',
          detail: hook.detail,
          fix: 'npm install -g sessionstat',
        }
  )

  // ── Where ────────────────────────────────────────────────────────────────
  let repoRoot: string | null = null
  if (options.project) {
    const dir = resolve(cwd, typeof options.project === 'string' ? options.project : '.')
    repoRoot = await repoRootOf(deps.run, dir)
    if (!repoRoot) {
      checks.push({
        ok: false,
        label: `${dir} is not inside a git repository`,
        fix: 'Run sessionstat setup --project from inside the repository',
      })
      printChecklist(out, checks)
      return {
        ok: false,
        checks,
        settingsPath: '',
        templatePath: '',
        hookCommand: hook.command,
      }
    }
  }
  const settingsPath = repoRoot ? projectSettingsPath(repoRoot) : paths.userSettings()

  // ── Hooks: write, then read back ─────────────────────────────────────────
  let before: Record<string, unknown> | null = null
  try {
    before = await readSettings(settingsPath)
    await installHooks(settingsPath, hook.command)
    const after = await readSettings(settingsPath)
    const events = await installedEvents(settingsPath)
    const missing = HOOK_EVENTS.filter(e => !events.includes(e))
    checks.push(
      missing.length === 0
        ? { ok: true, label: `Hooks installed in ${settingsPath}`, detail: HOOK_EVENTS.join(', ') }
        : { ok: false, label: `Hooks missing after install: ${missing.join(', ')}` }
    )
    const untouched = isDeepStrictEqual(withoutOurs(before), withoutOurs(after))
    checks.push(
      untouched
        ? { ok: true, label: 'Existing settings and hooks untouched' }
        : { ok: false, label: 'Existing settings changed during install — check the file' }
    )
  } catch (err) {
    checks.push({
      ok: false,
      label: `Could not install hooks in ${settingsPath}`,
      detail: err instanceof Error ? err.message : String(err),
    })
  }

  for (const path of await cleanupStaleHookLocations(settingsPath, repoRoot)) {
    checks.push({ ok: true, label: `Removed stale hooks from ${path}` })
  }

  // ── The other scope ──────────────────────────────────────────────────────
  if (repoRoot) {
    const config = await loadConfig()
    await updateConfig({
      projectInstalls: [...new Set([...(config.projectInstalls ?? []), repoRoot])],
    })
    if (await hasHooksInstalled(paths.userSettings())) {
      checks.push({
        ok: true,
        warn: true,
        label: `Also installed globally (${paths.userSettings()})`,
        detail: 'Each event fires twice; sessionstat de-duplicates them, but one scope is enough',
        fix: 'sessionstat uninstall   # to keep only this project install',
      })
    }
  } else {
    const repos = await projectInstallsWithHooks(await repoRootOf(deps.run, cwd))
    for (const repo of repos) {
      checks.push({
        ok: true,
        warn: true,
        label: `Also installed in ${projectSettingsPath(repo)}`,
        detail: 'Each event fires twice there; sessionstat de-duplicates them',
        fix: `sessionstat uninstall --project ${shellQuote(repo)}`,
      })
    }
  }

  // ── Template ─────────────────────────────────────────────────────────────
  const templatePath = repoRoot ? repoTemplatePath(repoRoot) : paths.homeTemplate()
  try {
    const copied = await copyTemplateIfAbsent(templatePath)
    checks.push({
      ok: true,
      label: copied ? `Template written to ${templatePath}` : `Template kept: ${templatePath}`,
      detail: 'Edit this to change what is posted; `sessionstat template vars` shows the fields',
    })
  } catch (err) {
    checks.push({ ok: false, label: `Could not write ${templatePath}`, detail: String(err) })
  }

  // ── Skill ────────────────────────────────────────────────────────────────
  try {
    const file = await installSkill(deps.version)
    checks.push({
      ok: true,
      label: `Claude skill installed at ${file}`,
      detail: `v${deps.version}`,
    })
  } catch (err) {
    checks.push({ ok: false, label: 'Could not install the Claude skill', detail: String(err) })
  }

  await mkdir(paths.sessions(), { recursive: true, mode: 0o700 })

  printChecklist(out, checks)
  const ok = checks.every(c => c.ok)
  return { ok, checks, settingsPath, templatePath, hookCommand: hook.command }
}

export function printChecklist(out: (line: string) => void, checks: CheckLine[]): void {
  out('')
  out('sessionstat setup')
  out('')
  for (const check of checks) {
    const mark = !check.ok ? '✗' : check.warn ? '!' : '✓'
    out(`  ${mark} ${check.label}`)
    if (check.detail) out(`      ${check.detail}`)
    if (check.fix && (!check.ok || check.warn)) out(`      fix: ${check.fix}`)
  }
  const failed = checks.filter(c => !c.ok).length
  out('')
  out(
    failed === 0
      ? '  All set. Stats will be posted to the PR for each branch you work on.'
      : `  ${failed} check${failed === 1 ? '' : 's'} failed. Hooks are installed, but nothing will be posted until ${failed === 1 ? 'it is' : 'they are'} fixed.`
  )
}

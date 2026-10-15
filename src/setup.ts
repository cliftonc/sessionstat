import { constants, access, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { repoSettingsPath } from './board/settings.js'
import { setupBoard } from './board/setup.js'
import { loadConfig, updateConfig } from './config.js'
import { paths, projectSettingsPath, repoTemplatePath, teamSettingsPath } from './paths.js'
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
import { DEFAULT_TEMPLATE, resolveTemplate } from './template/render.js'

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
  /** Ask the user a question; absent when not interactive, so nothing is asked. */
  ask?: (question: string) => Promise<string>
}

export interface SetupOptions {
  /** A path inside the repository to install into. Defaults to the working directory. */
  path?: string
  /** Install into the user-level settings, so it runs in every repository. Never the default. */
  global?: boolean
  /**
   * Install into the repository's committed `.claude/settings.json`, so it runs for everyone
   * who works in it. Absent: ask, if someone can answer; otherwise personal.
   */
  team?: boolean
  /**
   * The project board: `create`, a project URL, or `false` to not ask. Absent: offer one if
   * the repository has none and someone is there to answer.
   */
  projectBoard?: string | false
  /** Commit the board setting to the repository (`.claude/sessionstat.json`). Absent: ask. */
  shareBoard?: boolean
  /**
   * Write the default template out to edit: `repo` (`.claude/sessionstat.md`, shared), `home`
   * (`~/.sessionstat/template.md`) or `none`. Absent: ask, if someone can answer; else none.
   */
  template?: TemplateChoice
}

export type TemplateChoice = 'repo' | 'home' | 'none'

export const NOT_IN_REPO =
  'Not inside a git repository. Run it in the repo you want, or use --global to install everywhere'

/** One plain sentence saying where the hooks now run. */
export function scopeSentence(repoRoot: string | null, team = false): string {
  if (team && repoRoot) return `Installed for everyone working in ${repoRoot}`
  return repoRoot
    ? `Installed for ${repoRoot} only`
    : 'Installed globally: runs in every repository'
}

/**
 * The team hook command: committed, so it cannot name a path on this machine. A copy installed
 * in the repository (a devDependency, so the team pins the version) wins, then one on PATH;
 * with neither it does nothing, so a teammate without sessionstat sees no errors. Not npx: it
 * adds seconds to every hook. The trailing comment keeps `isSessionstatCommand` matching it.
 */
export const TEAM_HOOK_COMMAND =
  'b="$CLAUDE_PROJECT_DIR/node_modules/.bin/sessionstat"; if [ -x "$b" ]; then "$b" hook; elif command -v sessionstat >/dev/null 2>&1; then sessionstat hook; fi # sessionstat hook'

const yes = (answer: string) => /^y(es)?$/i.test(answer.trim())

export interface SetupResult {
  ok: boolean
  checks: CheckLine[]
  settingsPath: string
  /** The template in effect after setup; null for the built-in one. */
  templatePath: string | null
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

export async function repoRootOf(run: CommandRunner, dir: string): Promise<string | null> {
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
 * never read (the user-level `settings.local.json`), or, for a team install, this repository's
 * personal file, which the team hooks replace. The committed team file is the team's, so a
 * personal install only warns about it, as it does about a global install.
 */
export async function cleanupStaleHookLocations(
  installedPath: string,
  repoRoot: string | null
): Promise<string[]> {
  const candidates = new Set<string>([paths.legacyUserSettings()])
  if (repoRoot && installedPath === teamSettingsPath(repoRoot)) {
    candidates.add(projectSettingsPath(repoRoot))
  }
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

/**
 * Every repository-scope settings file (personal or team) that has our hooks, from config plus
 * the given repo.
 */
export async function projectInstallsWithHooks(extraRepo?: string | null): Promise<string[]> {
  const config = await loadConfig()
  const repos = new Set(config.projectInstalls ?? [])
  if (extraRepo) repos.add(extraRepo)
  const found: string[] = []
  for (const repo of repos) {
    for (const path of [projectSettingsPath(repo), teamSettingsPath(repo)]) {
      if (await hasHooksInstalled(path)) found.push(path)
    }
  }
  return found
}

/** Ask the walkthrough's questions that flags did not answer. Nobody to ask: the defaults. */
async function askChoices(
  options: SetupOptions,
  repoRoot: string | null,
  ask: SetupDeps['ask']
): Promise<{ team: boolean; template: TemplateChoice }> {
  let team = !!repoRoot && !!options.team
  if (repoRoot && options.team === undefined && ask) {
    team = yes(
      await ask(
        `Post session stats for everyone working in ${repoRoot} (writes .claude/settings.json, to commit)? [y/N] `
      )
    )
  }
  let template: TemplateChoice = options.template ?? 'none'
  if (options.template === undefined && ask) {
    const current = await resolveTemplate(repoRoot)
    if (current.source === 'default' && yes(await ask('Customise the comment template? [y/N] '))) {
      if (!repoRoot) template = 'home'
      else {
        const where = await ask(
          'For this repository, shared (.claude/sessionstat.md), or just for you everywhere (~/.sessionstat/template.md)? [repo/home] '
        )
        template = /^h/i.test(where.trim()) ? 'home' : 'repo'
      }
    }
  }
  return { team, template }
}

export async function runSetup(options: SetupOptions, deps: SetupDeps): Promise<SetupResult> {
  const checks: CheckLine[] = []
  const cwd = deps.cwd ?? process.cwd()
  const out = deps.out

  // ── Where: decided first, so a bad scope changes nothing ─────────────────
  // Per repository unless --global is given. Outside a repository that is an error, never a
  // quiet fall-back to a global install.
  const refuse = (message: string): SetupResult => {
    out(`sessionstat: ${message}`)
    return { ok: false, checks, settingsPath: '', templatePath: '', hookCommand: '' }
  }
  if (options.global && options.path) {
    return refuse('--global installs for every repository, so it takes no path')
  }
  if (options.global && options.team) {
    return refuse('--global and --team are different scopes; pick one')
  }
  let repoRoot: string | null = null
  if (!options.global) {
    const dir = resolve(cwd, options.path ?? '.')
    repoRoot = await repoRootOf(deps.run, dir)
    if (!repoRoot && (await deps.run('git', ['--version'], { timeoutMs: 5000 })).code !== 0) {
      return refuse('git is not on PATH, so the repository cannot be found. Install git first')
    }
    if (!repoRoot) {
      return refuse(options.path ? `${dir}: ${NOT_IN_REPO}` : NOT_IN_REPO)
    }
  }

  const choices = await askChoices(options, repoRoot, deps.ask)

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

  const settingsPath = !repoRoot
    ? paths.userSettings()
    : choices.team
      ? teamSettingsPath(repoRoot)
      : projectSettingsPath(repoRoot)
  const command = choices.team ? TEAM_HOOK_COMMAND : hook.command

  // ── Hooks: write, then read back ─────────────────────────────────────────
  let before: Record<string, unknown> | null = null
  let installed = false
  try {
    before = await readSettings(settingsPath)
    await installHooks(settingsPath, command)
    const after = await readSettings(settingsPath)
    const events = await installedEvents(settingsPath)
    const missing = HOOK_EVENTS.filter(e => !events.includes(e))
    installed = missing.length === 0
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
    if (!choices.team && (await hasHooksInstalled(teamSettingsPath(repoRoot)))) {
      checks.push({
        ok: true,
        warn: true,
        label: `Also installed for the team (${teamSettingsPath(repoRoot)})`,
        detail: 'Each event fires twice; sessionstat de-duplicates them, but one scope is enough',
        fix: 'sessionstat uninstall   # to drop your personal hooks and keep the team ones',
      })
    }
    if (await hasHooksInstalled(paths.userSettings())) {
      checks.push({
        ok: true,
        warn: true,
        label: `Also installed globally (${paths.userSettings()}): runs in every repository`,
        detail:
          'Here each event fires twice; sessionstat de-duplicates them, but one scope is enough',
        fix: 'sessionstat uninstall --global   # if you only want it per repository',
      })
    }
  } else {
    const files = await projectInstallsWithHooks(await repoRootOf(deps.run, cwd))
    for (const file of files) {
      const repo = dirname(dirname(file))
      const team = file === teamSettingsPath(repo)
      checks.push({
        ok: true,
        warn: true,
        label: `Also installed in ${file}`,
        detail: 'Each event fires twice there; sessionstat de-duplicates them',
        ...(team
          ? {}
          : { fix: `sessionstat uninstall ${shellQuote(repo)}   # the global install covers it` }),
      })
    }
  }

  // ── Template ─────────────────────────────────────────────────────────────
  // Nothing is written unless asked for: the built-in template is the default.
  let templatePath: string | null = null
  if (choices.template !== 'none') {
    const target =
      choices.template === 'repo' && repoRoot ? repoTemplatePath(repoRoot) : paths.homeTemplate()
    try {
      const copied = await copyTemplateIfAbsent(target)
      templatePath = target
      checks.push({
        ok: true,
        label: copied ? `Template written to ${target}` : `Template kept: ${target}`,
        detail: 'Edit this to change what is posted; `sessionstat template vars` shows the fields',
      })
    } catch (err) {
      checks.push({ ok: false, label: `Could not write ${target}`, detail: String(err) })
    }
  } else {
    const current = await resolveTemplate(repoRoot)
    templatePath = current.path
    checks.push({
      ok: true,
      label: current.path ? `Template: ${current.path}` : 'Template: the built-in default',
      ...(current.path
        ? {}
        : { detail: '`sessionstat template init` (or `--repo`) writes it out to customise' }),
    })
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

  // ── Project board ────────────────────────────────────────────────────────
  // Optional and separate from posting: a problem here is a warning, since comments still post.
  const boardRepo = repoRoot ?? (await repoRootOf(deps.run, cwd))
  if (boardRepo && options.projectBoard !== false) {
    try {
      const board = await setupBoard(
        {
          repoRoot: boardRepo,
          choice: options.projectBoard,
          share: repoRoot ? options.shareBoard : false,
          shareDefault: choices.team,
        },
        { run: deps.run, ask: deps.ask }
      )
      for (const check of board.checks) {
        checks.push(check.ok ? check : { ...check, ok: true, warn: true })
      }
    } catch (err) {
      checks.push({
        ok: true,
        warn: true,
        label: 'Could not set up the project board',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  await mkdir(paths.sessions(), { recursive: true, mode: 0o700 })

  printChecklist(
    out,
    checks,
    installed
      ? scopeSentence(repoRoot, choices.team)
      : `Not installed (${settingsPath} was not updated)`
  )
  if (installed && repoRoot) {
    const shared = [
      teamSettingsPath(repoRoot),
      repoTemplatePath(repoRoot),
      repoSettingsPath(repoRoot),
    ]
    const toCommit: string[] = []
    for (const path of shared) {
      if (path === teamSettingsPath(repoRoot) && !choices.team) continue
      if (await exists(path)) toCommit.push(path.slice(repoRoot.length + 1))
    }
    if (toCommit.length > 0) out(`  Commit to share with the team: ${toCommit.join(', ')}`)
  }
  const ok = checks.every(c => c.ok)
  return { ok, checks, settingsPath, templatePath, hookCommand: command }
}

export function printChecklist(
  out: (line: string) => void,
  checks: CheckLine[],
  scope: string
): void {
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
  out(`  ${scope}.`)
  out(
    failed === 0
      ? '  All set. Stats will be posted to the PR for each branch you work on.'
      : `  ${failed} check${failed === 1 ? '' : 's'} failed. Hooks are installed, but nothing will be posted until ${failed === 1 ? 'it is' : 'they are'} fixed.`
  )
}

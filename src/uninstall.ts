import { resolve } from 'node:path'
import { loadConfig, updateConfig } from './config.js'
import { paths, projectSettingsPath, teamSettingsPath } from './paths.js'
import type { CommandRunner } from './runner.js'
import { hasHooksInstalled, removeHooks } from './settings.js'
import { projectInstallsWithHooks, repoRootOf } from './setup.js'
import { removeSkill } from './skill.js'

/**
 * Adapted from guidemode `packages/cli/src/uninstall.ts`: remove our hooks from the chosen
 * scope, leave everyone else's, and keep local state (the template, scratch, logs). The skill
 * goes only when no scope has hooks left, because it describes an install that still exists.
 */

export interface UninstallOptions {
  /** A path inside the repository to uninstall from. Defaults to the working directory. */
  path?: string
  /** Remove the user-level hooks, the ones that run in every repository. */
  global?: boolean
  /** Remove the repository's team hooks (the committed `.claude/settings.json`) instead. */
  team?: boolean
}

export const NOT_IN_REPO_UNINSTALL =
  'Not inside a git repository. Run it in the repo to uninstall from, or use --global for the global hooks'

export interface UninstallDeps {
  run: CommandRunner
  out: (line: string) => void
  cwd?: string
}

export interface UninstallResult {
  removedFrom: string[]
  skillRemoved: boolean
  stillInstalled: string[]
  /** False when the scope could not be resolved (outside a repository without --global). */
  ok: boolean
}

export async function runUninstall(
  options: UninstallOptions,
  deps: UninstallDeps
): Promise<UninstallResult> {
  const out = deps.out
  const cwd = deps.cwd ?? process.cwd()
  const removedFrom: string[] = []
  let scopeRoot = ''

  const tryRemove = async (path: string) => {
    try {
      if (await removeHooks(path)) removedFrom.push(path)
    } catch (err) {
      out(`! Skipped ${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (options.global && options.team) {
    out('sessionstat: --global and --team are different scopes; pick one')
    return { ok: false, removedFrom, skillRemoved: false, stillInstalled: [] }
  }
  if (options.global && options.path) {
    out('sessionstat: --global removes the hooks for every repository, so it takes no path')
    return { ok: false, removedFrom, skillRemoved: false, stillInstalled: [] }
  }

  if (!options.global) {
    const dir = resolve(cwd, options.path ?? '.')
    const config = await loadConfig()
    // A recorded install whose repository has since lost its .git can still be cleaned up.
    const repoRoot =
      (await repoRootOf(deps.run, dir)) ?? (config.projectInstalls?.includes(dir) ? dir : null)
    if (!repoRoot) {
      out(`sessionstat: ${options.path ? `${dir}: ` : ''}${NOT_IN_REPO_UNINSTALL}`)
      return { ok: false, removedFrom, skillRemoved: false, stillInstalled: [] }
    }
    // The team file is shared, so it is only touched when asked for by name.
    await tryRemove(options.team ? teamSettingsPath(repoRoot) : projectSettingsPath(repoRoot))
    const other = options.team ? projectSettingsPath(repoRoot) : teamSettingsPath(repoRoot)
    if (!(await hasHooksInstalled(other))) {
      await updateConfig({
        projectInstalls: (config.projectInstalls ?? []).filter(r => r !== repoRoot),
      })
    }
    scopeRoot = repoRoot
  } else {
    await tryRemove(paths.userSettings())
    await tryRemove(paths.legacyUserSettings())
  }

  const scope = options.global
    ? 'the global install'
    : options.team
      ? `the team install for ${scopeRoot}`
      : `the install for ${scopeRoot}`
  for (const path of removedFrom) out(`✓ Removed sessionstat hooks from ${path}`)
  if (removedFrom.length > 0) out(`  Removed ${scope}.`)
  else out(`  No sessionstat hooks found for ${options.global ? 'the global scope' : scopeRoot}.`)
  if (!options.global && !options.team && (await hasHooksInstalled(teamSettingsPath(scopeRoot)))) {
    out(`! The team install remains (${teamSettingsPath(scopeRoot)}): it runs for everyone in`)
    out('  this repository. sessionstat uninstall --team removes it (commit the change).')
  }

  const stillInstalled: string[] = []
  if (await hasHooksInstalled(paths.userSettings())) stillInstalled.push(paths.userSettings())
  stillInstalled.push(...(await projectInstallsWithHooks()))

  let skillRemoved = false
  const globalLeft = stillInstalled.includes(paths.userSettings())
  if (!options.global && globalLeft) {
    out(
      `! The global install remains (${paths.userSettings()}): it still runs in every repository,`
    )
    out('  this one included. sessionstat uninstall --global removes it.')
  }

  if (stillInstalled.length === 0) {
    skillRemoved = await removeSkill()
    if (skillRemoved) out(`✓ Removed the Claude skill at ${paths.skillDir()}`)
  } else {
    out('  Still installed in:')
    for (const path of stillInstalled) out(`    ${path}`)
    out('  The Claude skill is kept while any install remains.')
  }

  out(
    `  Templates, recorded sessions and logs in ${paths.homeTemplate().replace(/\/template\.md$/, '')} are kept.`
  )
  return { ok: true, removedFrom, skillRemoved, stillInstalled }
}

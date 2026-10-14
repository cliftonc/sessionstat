import { join, resolve } from 'node:path'
import { loadConfig, updateConfig } from './config.js'
import { paths, projectSettingsPath } from './paths.js'
import type { CommandRunner } from './runner.js'
import { hasHooksInstalled, removeHooks } from './settings.js'
import { projectInstallsWithHooks } from './setup.js'
import { removeSkill } from './skill.js'

/**
 * Adapted from guidemode `packages/cli/src/uninstall.ts`: remove our hooks from the chosen
 * scope, leave everyone else's, and keep local state (the template, scratch, logs). The skill
 * goes only when no scope has hooks left, because it describes an install that still exists.
 */

export interface UninstallOptions {
  project?: string | boolean
}

export interface UninstallDeps {
  run: CommandRunner
  out: (line: string) => void
  cwd?: string
}

export interface UninstallResult {
  removedFrom: string[]
  skillRemoved: boolean
  stillInstalled: string[]
}

export async function runUninstall(
  options: UninstallOptions,
  deps: UninstallDeps
): Promise<UninstallResult> {
  const out = deps.out
  const cwd = deps.cwd ?? process.cwd()
  const removedFrom: string[] = []

  const tryRemove = async (path: string) => {
    try {
      if (await removeHooks(path)) removedFrom.push(path)
    } catch (err) {
      out(`! Skipped ${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (options.project) {
    const dir = resolve(cwd, typeof options.project === 'string' ? options.project : '.')
    const top = await deps.run('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      timeoutMs: 5000,
    })
    const repoRoot = top.code === 0 ? top.stdout.trim() : dir
    await tryRemove(projectSettingsPath(repoRoot))
    await tryRemove(join(repoRoot, '.claude', 'settings.json'))
    const config = await loadConfig()
    await updateConfig({
      projectInstalls: (config.projectInstalls ?? []).filter(r => r !== repoRoot),
    })
  } else {
    await tryRemove(paths.userSettings())
    await tryRemove(paths.legacyUserSettings())
  }

  for (const path of removedFrom) out(`✓ Removed sessionstat hooks from ${path}`)
  if (removedFrom.length === 0) out('  No sessionstat hooks found in that scope.')

  const stillInstalled: string[] = []
  if (await hasHooksInstalled(paths.userSettings())) stillInstalled.push(paths.userSettings())
  for (const repo of await projectInstallsWithHooks()) {
    stillInstalled.push(projectSettingsPath(repo))
  }

  let skillRemoved = false
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
  return { removedFrom, skillRemoved, stillInstalled }
}

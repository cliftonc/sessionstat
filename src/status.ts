import { listChecks, pollerRunning } from './checks.js'
import { isEnabledFor, loadConfig } from './config.js'
import { getGitMetadata } from './git.js'
import { lastError } from './log.js'
import { paths, projectSettingsPath, teamSettingsPath } from './paths.js'
import type { CommandRunner } from './runner.js'
import { listSessions } from './sessions.js'
import { hasHooksInstalled, installedEvents } from './settings.js'
import { installedSkillVersion } from './skill.js'
import { resolveTemplate } from './template/render.js'

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (Math.abs(minutes) < 60) return `${minutes}m`
  return `${Math.round(minutes / 6) / 10}h`
}

/** Which scopes cover the repository at `root` (null: not in a repository). */
export function scopeSummary(
  root: string | null,
  repo: boolean,
  global: boolean,
  team = false
): string {
  const on = [repo && 'this repository', team && 'the team', global && 'global'].filter(Boolean)
  if (on.length > 1) return `${on.join(' and ')} (each event fires twice; de-duplicated)`
  if (global) return root ? 'global (covers this repository)' : 'global'
  if (team) return 'the team: everyone working in this repository'
  if (repo) return 'this repository only'
  return root ? 'not installed for this repository (sessionstat setup)' : 'not in a git repository'
}

export async function runStatus(deps: {
  run: CommandRunner
  out: (line: string) => void
  cwd?: string
  clock?: () => number
}): Promise<void> {
  const out = deps.out
  const now = deps.clock?.() ?? Date.now()
  const config = await loadConfig()
  const meta = await getGitMetadata(deps.cwd ?? process.cwd(), deps.run)

  out('sessionstat status')
  out('')
  out('Installed')
  const userEvents = await installedEvents(paths.userSettings())
  const globalOn = userEvents.length > 0
  const repoEvents = meta.toplevel ? await installedEvents(projectSettingsPath(meta.toplevel)) : []
  const repoOn = repoEvents.length > 0
  const teamEvents = meta.toplevel ? await installedEvents(teamSettingsPath(meta.toplevel)) : []
  const teamOn = teamEvents.length > 0
  out(`  scope    ${scopeSummary(meta.toplevel, repoOn, globalOn, teamOn)}`)
  if (globalOn) {
    out(`  ! global install: runs in every repository (${paths.userSettings()})`)
  }
  if (meta.toplevel) {
    out(
      `  repo     ${repoOn ? `yes (${projectSettingsPath(meta.toplevel)}: ${repoEvents.join(', ')})` : 'no (sessionstat setup)'}`
    )
    out(
      `  team     ${teamOn ? `yes (${teamSettingsPath(meta.toplevel)}: ${teamEvents.join(', ')})` : 'no (sessionstat setup --team)'}`
    )
  }
  out(`  global   ${globalOn ? `yes (${paths.userSettings()}: ${userEvents.join(', ')})` : 'no'}`)
  const others = (config.projectInstalls ?? []).filter(r => r !== meta.toplevel)
  for (const repo of others) {
    for (const path of [projectSettingsPath(repo), teamSettingsPath(repo)]) {
      if (await hasHooksInstalled(path)) out(`  also     ${path}`)
    }
  }
  const skill = await installedSkillVersion()
  out(`  skill    ${skill ? `yes, v${skill} (${paths.skillFile()})` : 'no'}`)

  const auth = await deps.run('gh', ['auth', 'status'], { timeoutMs: 15000 })
  out(
    `  gh       ${auth.notFound ? 'not installed — brew install gh' : auth.code === 0 ? 'logged in' : 'not logged in — gh auth login'}`
  )
  out('')

  out('Settings')
  out(`  enabled  ${config.enabled === false ? 'no (sessionstat enable --global)' : 'yes'}`)
  out(`  notice   ${config.notice === false ? 'off' : 'on'}`)
  out('')

  if (meta.toplevel) {
    const template = await resolveTemplate(meta.toplevel)
    out('This repository')
    out(`  root     ${meta.toplevel}`)
    out(`  branch   ${meta.branch ?? '(detached)'}`)
    out(`  enabled  ${isEnabledFor(config, meta.toplevel) ? 'yes' : 'no (sessionstat enable)'}`)
    out(`  template ${template.source}${template.path ? ` (${template.path})` : ''}`)
    out('')
  }

  const sessions = await listSessions()
  const here = meta.toplevel
    ? sessions.filter(
        s => s.repoRoot === meta.toplevel && meta.branch && s.branches.includes(meta.branch)
      )
    : []
  out(
    `Sessions recorded: ${sessions.length}${meta.toplevel ? ` (${here.length} on this branch)` : ''}`
  )
  for (const s of here.slice(-5)) {
    out(`  ${s.sessionId.slice(0, 8)}  ${s.firstSeenAt}${s.endedAt ? '  ended' : ''}`)
  }
  out('')

  const checks = await listChecks()
  out(`Queued PR checks: ${checks.length}${(await pollerRunning()) ? ' (poller running)' : ''}`)
  for (const c of checks) {
    const next = c.dueAt[0]
    out(`  ${c.branch} in ${c.repoRoot}${next ? ` — next in ${ago(next - now)}` : ''}`)
  }
  out('')

  const err = await lastError()
  out(`Last error: ${err ?? 'none'}`)
}

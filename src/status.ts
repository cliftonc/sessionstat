import { listChecks, pollerRunning } from './checks.js'
import { isEnabledFor, loadConfig } from './config.js'
import { getGitMetadata } from './git.js'
import { lastError } from './log.js'
import { paths, projectSettingsPath } from './paths.js'
import type { CommandRunner } from './runner.js'
import { listSessions } from './sessions.js'
import { installedEvents } from './settings.js'
import { installedSkillVersion } from './skill.js'
import { resolveTemplate } from './template/render.js'

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (Math.abs(minutes) < 60) return `${minutes}m`
  return `${Math.round(minutes / 6) / 10}h`
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
  out(
    `  global   ${userEvents.length > 0 ? `yes (${paths.userSettings()}: ${userEvents.join(', ')})` : 'no'}`
  )
  const repos = new Set(config.projectInstalls ?? [])
  if (meta.toplevel) repos.add(meta.toplevel)
  for (const repo of repos) {
    const events = await installedEvents(projectSettingsPath(repo))
    if (events.length > 0 || config.projectInstalls?.includes(repo)) {
      out(`  project  ${events.length > 0 ? 'yes' : 'no'} (${projectSettingsPath(repo)})`)
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

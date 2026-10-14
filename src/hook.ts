import { hasDueChecks, pollerRunning, queueChecks } from './checks.js'
import { isEnabledFor, loadConfig } from './config.js'
import { getGitMetadata, isGitHubRemote } from './git.js'
import { log } from './log.js'
import { noticeJson, noticeText, startLookup } from './notice.js'
import type { CommandRunner } from './runner.js'
import { recordSession } from './sessions.js'
import { type Spawner, claimHookEvent } from './worker.js'

/**
 * `sessionstat hook`: what every Claude Code hook runs.
 *
 * Fast and silent, after guidemode's `hook-entry.ts`: read the JSON on stdin, write a small
 * record, hand anything slow (gh, parsing transcripts) to a detached worker, exit. It never
 * prints anything except the SessionStart notice, and never fails visibly.
 */

export interface HookInput {
  sessionId: string
  transcriptPath: string
  cwd: string
  hookEvent: string
  toolName: string
  command: string
}

export function parseHookInput(raw: string): HookInput | null {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    const toolInput = (d.tool_input ?? {}) as Record<string, unknown>
    return {
      sessionId: str(d.session_id),
      transcriptPath: str(d.transcript_path),
      cwd: str(d.cwd),
      hookEvent: str(d.hook_event_name),
      toolName: str(d.tool_name),
      command: str(toolInput.command),
    }
  } catch {
    return null
  }
}

/** A Bash call after which a PR may newly exist, or have new commits. */
const PR_TRIGGER = /\bgit\s+push\b|\bgh\s+pr\s+(create|ready|edit|reopen)\b/

export function isPrTrigger(command: string): boolean {
  return PR_TRIGGER.test(command)
}

export interface HookDeps {
  run: CommandRunner
  spawn: Spawner
  clock: () => number
  write: (text: string) => void
  noticeTimeoutMs?: number
}

export interface HookResult {
  deduped?: boolean
  recorded: boolean
  spawned: string[][]
  notice: string | null
}

export async function handleHook(raw: string, deps: HookDeps): Promise<HookResult> {
  const result: HookResult = { recorded: false, spawned: [], notice: null }
  const spawn = (args: string[]) => {
    result.spawned.push(args)
    deps.spawn(args)
  }

  const input = parseHookInput(raw)
  if (input?.sessionId) {
    // Installed at both user and project scope, Claude Code fires both for one event.
    if (!(await claimHookEvent(raw, 5000, deps.clock()))) {
      return { ...result, deduped: true }
    }
    await handleSessionEvent(input, deps, result, spawn)
  }

  // Every hook, in any repository, catches up checks a dead poller missed.
  if (input?.hookEvent !== 'SessionEnd') {
    const now = deps.clock()
    if ((await hasDueChecks(now)) && !(await pollerRunning())) spawn(['poller'])
  }
  return result
}

async function handleSessionEvent(
  input: HookInput,
  deps: HookDeps,
  result: HookResult,
  spawn: (args: string[]) => void
): Promise<void> {
  const event = input.hookEvent
  const config = await loadConfig()

  const meta = await getGitMetadata(input.cwd, deps.run)

  // One PR lookup at SessionStart, short timeout: it feeds the notice AND records whether this
  // session is follow-up work on an existing PR.
  let openedBeforePr: boolean | undefined
  if (event === 'SessionStart') {
    const lookup = await startLookup(meta, config, deps.run, deps.noticeTimeoutMs).catch(() => null)
    if (lookup?.status === 'found') openedBeforePr = true
    else if (lookup?.status === 'none') openedBeforePr = false
    const notice = noticeText(lookup, meta, config)
    if (notice) {
      result.notice = notice
      deps.write(noticeJson(notice))
    }
  }

  if (!meta.toplevel || !isEnabledFor(config, meta.toplevel)) return

  const record = await recordSession({
    sessionId: input.sessionId,
    transcriptPath: input.transcriptPath,
    cwd: input.cwd,
    repoRoot: meta.toplevel,
    remote: meta.remoteUrl,
    branch: meta.branch,
    head: meta.commitHash,
    recordCommit: event === 'Stop' || event === 'SessionEnd',
    openedBeforePr,
    ended: event === 'SessionEnd',
    now: new Date(deps.clock()),
  })
  result.recorded = true

  // Recorded either way, but only a GitHub repository has a PR to look for.
  if (!isGitHubRemote(meta.remoteUrl)) return

  const branch = meta.branch
  const postNow = () => {
    if (branch) spawn(['post-worker', '--repo', meta.toplevel as string, '--branch', branch])
  }

  switch (event) {
    case 'SessionStart':
    case 'Stop':
      postNow()
      break
    case 'PostToolUse':
      if (input.toolName === 'Bash' && isPrTrigger(input.command)) postNow()
      break
    case 'SessionEnd': {
      postNow()
      for (const b of record.branches) await queueChecks(meta.toplevel, b, deps.clock())
      spawn(['poller'])
      await log(
        'INFO',
        `Session ${input.sessionId} ended; queued checks for ${record.branches.join(', ')}`
      )
      break
    }
    default:
      break
  }
}

export function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = ''
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(''))
  })
}

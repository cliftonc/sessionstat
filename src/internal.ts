import { postWithLock, runPoller } from './checks.js'
import { handleHook, readStdin } from './hook.js'
import { log } from './log.js'
import { runCommand } from './runner.js'
import { spawnDetached } from './worker.js'

/**
 * The commands that run from hooks or as detached workers. They never fail visibly: a hook
 * that prints a stack trace into a Claude Code session is worse than one that does nothing.
 */

export async function runHookFromStdin(): Promise<void> {
  try {
    const raw = await readStdin()
    await handleHook(raw, {
      run: runCommand,
      spawn: spawnDetached,
      clock: Date.now,
      write: text => process.stdout.write(text),
    })
  } catch (err) {
    await log('ERROR', `hook failed: ${err instanceof Error ? err.stack : String(err)}`)
  }
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

export async function runInternal(argv: string[]): Promise<boolean> {
  const command = argv[2]
  try {
    if (command === 'hook') {
      await runHookFromStdin()
      return true
    }
    if (command === 'post-worker') {
      const repo = flag(argv, '--repo')
      const branch = flag(argv, '--branch')
      if (repo && branch) {
        const outcome = await postWithLock(repo, branch, { run: runCommand })
        if (outcome && outcome.status !== 'unchanged' && outcome.status !== 'no-sessions') {
          await log('INFO', `post ${repo} ${branch}: ${outcome.status}`)
        }
      }
      return true
    }
    if (command === 'poller') {
      await runPoller({
        run: runCommand,
        clock: Date.now,
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      })
      return true
    }
  } catch (err) {
    await log('ERROR', `${command} failed: ${err instanceof Error ? err.stack : String(err)}`)
    return true
  }
  return false
}

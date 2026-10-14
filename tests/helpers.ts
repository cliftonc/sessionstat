import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandRunner, RunOptions, RunResult } from '../src/runner.js'

export const FIXTURES = join(import.meta.dirname, 'fixtures')

/** Point HOME at a fresh temp dir for one test, so nothing real is read or written. */
export async function useTempHome(): Promise<{ home: string; restore: () => Promise<void> }> {
  const previous = { HOME: process.env.HOME, SESSIONSTAT_HOME: process.env.SESSIONSTAT_HOME }
  const home = await mkdtemp(join(tmpdir(), 'sessionstat-test-'))
  process.env.HOME = home
  // biome-ignore lint/performance/noDelete: env vars must be removed, not set to "undefined"
  delete process.env.SESSIONSTAT_HOME
  return {
    home,
    restore: async () => {
      process.env.HOME = previous.HOME
      if (previous.SESSIONSTAT_HOME !== undefined) {
        process.env.SESSIONSTAT_HOME = previous.SESSIONSTAT_HOME
      }
      await rm(home, { recursive: true, force: true })
    },
  }
}

export interface Call {
  cmd: string
  args: string[]
  options?: RunOptions
}

export const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' })
export const failed = (stderr = '', code = 1): RunResult => ({ code, stdout: '', stderr })
export const notFound = (): RunResult => ({
  code: -1,
  stdout: '',
  stderr: 'ENOENT',
  notFound: true,
})

export interface Repo {
  root: string
  remote?: string | null
  branch?: string
  head?: string
}

/**
 * A fake `git` + `gh`. Git answers from `repos` (keyed by root; any cwd inside a root
 * matches). `gh` calls go to `gh`, which gets the args; unhandled commands fail.
 */
export function fakeRunner(config: {
  repos?: Repo[]
  gh?: (args: string[], options?: RunOptions) => RunResult | Promise<RunResult>
  other?: (cmd: string, args: string[]) => RunResult | undefined
}): CommandRunner & { calls: Call[] } {
  const calls: Call[] = []
  const runner = (async (cmd, args, options) => {
    calls.push({ cmd, args, options })
    if (cmd === 'git') {
      if (args[0] === '--version') return ok('git version 2.50.0')
      const cwd = options?.cwd ?? ''
      const repo = config.repos?.find(r => cwd === r.root || cwd.startsWith(`${r.root}/`))
      if (!repo) return failed('fatal: not a git repository', 128)
      const joined = args.join(' ')
      if (joined === 'rev-parse --show-toplevel') return ok(`${repo.root}\n`)
      if (joined === 'remote get-url origin') {
        return repo.remote ? ok(`${repo.remote}\n`) : failed('error: No such remote', 2)
      }
      if (joined === 'rev-parse --abbrev-ref HEAD') return ok(`${repo.branch ?? 'main'}\n`)
      if (joined === 'rev-parse HEAD') return ok(`${repo.head ?? 'abc123'}\n`)
      return failed(`unexpected git ${joined}`)
    }
    if (cmd === 'gh' && config.gh) return config.gh(args, options)
    const other = config.other?.(cmd, args)
    if (other) return other
    return notFound()
  }) as CommandRunner & { calls: Call[] }
  runner.calls = calls
  return runner
}

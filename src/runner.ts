import { spawn } from 'node:child_process'

export interface RunResult {
  /** Exit code; -1 when the process never ran or was killed. */
  code: number
  stdout: string
  stderr: string
  /** The command is not installed. */
  notFound?: boolean
  timedOut?: boolean
}

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  /** Written to stdin, which is then closed. */
  input?: string
}

/**
 * How sessionstat runs `git` and `gh`. Injected everywhere so tests use a fake `gh` and never
 * reach GitHub. Never throws: every failure is a result.
 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  options?: RunOptions
) => Promise<RunResult>

export const runCommand: CommandRunner = (cmd, args, options = {}) =>
  new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err), notFound: true })
      return
    }

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, options.timeoutMs)
      : undefined

    child.stdout?.on('data', chunk => {
      stdout += chunk
    })
    child.stderr?.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', err => {
      const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT'
      finish({ code: -1, stdout, stderr: stderr || err.message, notFound })
    })
    child.on('close', code => {
      finish({ code: timedOut ? -1 : (code ?? -1), stdout, stderr, timedOut })
    })

    if (options.input !== undefined) child.stdin?.end(options.input)
    else child.stdin?.end()
  })

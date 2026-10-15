import { writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Command, Option } from 'commander'
import pkg from '../package.json' with { type: 'json' }
import { runBoardResync, runBoardStatus } from './board/commands.js'
import { setupBoard } from './board/setup.js'
import { commandDoc } from './commands.js'
import { isEnabledFor, loadConfig, updateConfig } from './config.js'
import { type PullRequest, currentLogin, fetchComments, findOurComment, findPr } from './gh.js'
import { getGitMetadata } from './git.js'
import { readLogTail } from './log.js'
import { paths, repoTemplatePath } from './paths.js'
import { buildComment, buildCommentFromTranscripts, postForBranch } from './post.js'
import { readPrState } from './pr-state.js'
import { type CommandRunner, runCommand } from './runner.js'
import { runSetup } from './setup.js'
import { runStatus } from './status.js'
import { type DataSession, parseDataBlock } from './template/data.js'
import { DEFAULT_TEMPLATE } from './template/render.js'
import { runUninstall } from './uninstall.js'

export const VERSION: string = pkg.version

export interface ProgramDeps {
  run: CommandRunner
  out: (line: string) => void
  err: (line: string) => void
  cwd: () => string
  setExitCode: (code: number) => void
  /** Ask the user something. Absent when stdin or stdout is not a terminal. */
  ask?: (question: string) => Promise<string>
}

/** A question on the terminal, or nothing when there is no one at it (CI, a pipe, a hook). */
function terminalAsk(): ((question: string) => Promise<string>) | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined
  return async question => {
    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return await rl.question(question)
    } finally {
      rl.close()
    }
  }
}

const defaultDeps: ProgramDeps = {
  run: runCommand,
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
  cwd: () => process.cwd(),
  setExitCode: code => {
    process.exitCode = code
  },
  ask: terminalAsk(),
}

interface ScopeFlags {
  global?: boolean
  team?: boolean
  project?: string | boolean
  projectBoard?: string | false
  shareBoard?: boolean
  template?: string
}

interface ViewOptions {
  transcript?: string[]
  pr?: boolean
  all?: boolean
}

async function currentBranchComment(deps: ProgramDeps, options: ViewOptions) {
  const meta = await getGitMetadata(deps.cwd(), deps.run)
  let pr: PullRequest | null = null
  if (options.pr !== false && meta.toplevel) {
    const lookup = await findPr(deps.run, meta.toplevel, { timeoutMs: 10_000 })
    if (lookup.status === 'found') pr = lookup.pr
  }
  if (options.transcript && options.transcript.length > 0) {
    return buildCommentFromTranscripts(options.transcript, {
      repoRoot: meta.toplevel,
      branch: meta.branch ?? '',
      pr,
    })
  }
  if (!meta.toplevel || !meta.branch) {
    throw new Error('Not on a branch of a git repository. Pass --transcript <file> to preview one.')
  }

  // What the comment would be rendered from: local sessions merged over what is already on the
  // PR - this user's comment, or with --all every sessionstat comment on it. Best effort.
  let login: string | null = null
  let remote: DataSession[] = []
  if (pr) {
    const me = await currentLogin(deps.run, meta.toplevel)
    if (me.ok) login = me.login
    if (options.all) {
      const state = await readPrState(deps.run, meta.toplevel, pr)
      if (state.ok) remote = state.state.sessions
      else deps.err(`Could not read the PR's comments: ${state.message}`)
    } else if (login) {
      const comments = await fetchComments(deps.run, meta.toplevel, pr.number)
      const ours = comments.ok ? findOurComment(comments.output, login) : null
      if (ours) remote = parseDataBlock(ours.body)?.sessions ?? []
    }
  }

  const built = await buildComment(meta.toplevel, meta.branch, pr, { login, remote })
  if (built.sessions.length === 0) {
    deps.err(
      `No sessions recorded on ${meta.branch} yet. Pass --transcript <file> to preview a transcript.`
    )
  }
  return built
}

export function buildProgram(overrides: Partial<ProgramDeps> = {}): Command {
  const deps: ProgramDeps = { ...defaultDeps, ...overrides }
  const program = new Command()
  program
    .name('sessionstat')
    .description('Post Claude Code session stats on your pull requests, using your own gh login')
    .version(VERSION)

  const fail = (err: unknown) => {
    deps.err(`sessionstat: ${err instanceof Error ? err.message : String(err)}`)
    deps.setExitCode(1)
  }

  /**
   * `--project [path]` was how you asked for a per-repository install before that became the
   * default. Kept, hidden, as an alias for it so existing scripts and docs keep working.
   */
  const scopeArgs = (
    command: string,
    given: string | undefined,
    opts: ScopeFlags
  ): { path?: string; global?: boolean } | null => {
    let path = given
    if (opts.project !== undefined) {
      deps.err(
        `sessionstat: --project is deprecated: per-repository is now the default (sessionstat ${command} [path])`
      )
      if (opts.global) {
        fail(new Error('--project and --global are different scopes; pick one'))
        return null
      }
      if (typeof opts.project === 'string') {
        if (path && path !== opts.project) {
          fail(new Error('Give the repository path once, not as both [path] and --project'))
          return null
        }
        path = opts.project
      }
    }
    return { path, global: opts.global }
  }
  const projectAlias = () =>
    new Option('--project [path]', 'deprecated: per-repository is the default').hideHelp()

  program
    .command('setup')
    .alias('install')
    .description(commandDoc('setup'))
    .argument('[path]', 'a path inside the repository to install into (default: here)')
    .option('--global', 'install for every repository instead (~/.claude/settings.json)')
    .option(
      '--team',
      'install for everyone working in the repository (.claude/settings.json, to commit)'
    )
    .option(
      '--project-board <url|create>',
      'also mirror stats to a GitHub Projects board: an existing project URL, or create one'
    )
    .option('--no-project-board', 'do not offer a project board')
    .option('--share-board', 'save the board setting in .claude/sessionstat.json, to commit')
    .addOption(
      new Option('--template <where>', 'write the default template out to edit').choices([
        'repo',
        'home',
        'none',
      ])
    )
    .addOption(projectAlias())
    .action(async (path: string | undefined, opts: ScopeFlags) => {
      try {
        const scope = scopeArgs('setup', path, opts)
        if (!scope) return
        const result = await runSetup(
          {
            ...scope,
            team: opts.team,
            projectBoard: opts.projectBoard,
            shareBoard: opts.shareBoard,
            template: opts.template as 'repo' | 'home' | 'none' | undefined,
          },
          {
            run: deps.run,
            out: deps.out,
            version: VERSION,
            cwd: deps.cwd(),
            ask: deps.ask,
          }
        )
        if (!result.ok) deps.setExitCode(1)
      } catch (err) {
        fail(err)
      }
    })

  program
    .command('uninstall')
    .description(commandDoc('uninstall'))
    .argument('[path]', 'a path inside the repository to remove it from (default: here)')
    .option('--global', 'remove the global hooks, the ones that run in every repository')
    .option('--team', 'remove the team hooks from the repository’s .claude/settings.json')
    .addOption(projectAlias())
    .action(async (path: string | undefined, opts: ScopeFlags) => {
      try {
        const scope = scopeArgs('uninstall', path, opts)
        if (!scope) return
        const result = await runUninstall(
          { ...scope, team: opts.team },
          { run: deps.run, out: deps.out, cwd: deps.cwd() }
        )
        if (!result.ok) deps.setExitCode(1)
      } catch (err) {
        fail(err)
      }
    })

  program
    .command('status')
    .description(commandDoc('status'))
    .action(async () => {
      try {
        await runStatus({ run: deps.run, out: deps.out, cwd: deps.cwd() })
      } catch (err) {
        fail(err)
      }
    })

  program
    .command('show')
    .description(commandDoc('show'))
    .option(
      '--transcript <file...>',
      'render these Claude transcripts instead of recorded sessions'
    )
    .option('--all', 'include every sessionstat comment on the PR, from every author')
    .option('--no-pr', 'do not look up the PR')
    .action(async (opts: ViewOptions) => {
      try {
        const built = await currentBranchComment(deps, opts)
        if (built.rendered.fallbackError) {
          deps.err(
            `Template failed (${built.rendered.fallbackError}); showing the default instead.`
          )
        }
        deps.out(built.rendered.body.trimEnd())
      } catch (err) {
        fail(err)
      }
    })

  program
    .command('post')
    .description(commandDoc('post'))
    .option('--force', 'write the comment even if it has not changed')
    .action(async (opts: { force?: boolean }) => {
      try {
        const meta = await getGitMetadata(deps.cwd(), deps.run)
        if (!meta.toplevel || !meta.branch) throw new Error('Not on a branch of a git repository')
        const outcome = await postForBranch(
          meta.toplevel,
          meta.branch,
          { run: deps.run },
          { force: opts.force }
        )
        switch (outcome.status) {
          case 'created':
          case 'updated':
            deps.out(`✓ ${outcome.status} the comment on ${outcome.pr.url}`)
            if (outcome.board?.status === 'error') {
              deps.err(`  project board not updated: ${outcome.board.message}`)
            } else if (outcome.board) {
              deps.out(`✓ project board ${outcome.board.status}: ${outcome.board.url}`)
            }
            break
          case 'unchanged':
            deps.out(`✓ Comment on ${outcome.pr.url} is already up to date (--force to rewrite)`)
            break
          case 'no-sessions':
            deps.out(`No sessions recorded on ${meta.branch}; nothing to post.`)
            break
          case 'disabled':
            deps.out('sessionstat is disabled for this repository (sessionstat enable).')
            break
          case 'no-pr':
            deps.out(
              outcome.lookup === 'not-authenticated'
                ? 'gh is not logged in: run `gh auth login`.'
                : outcome.lookup === 'not-installed'
                  ? 'gh is not installed: `brew install gh`.'
                  : `No open PR for ${meta.branch} (${outcome.lookup}).`
            )
            deps.setExitCode(1)
            break
          case 'error':
            throw new Error(outcome.message)
        }
      } catch (err) {
        fail(err)
      }
    })

  const board = program
    .command('board')
    .description('Mirror session stats into a GitHub Projects board')
  board
    .command('setup')
    .description(commandDoc('board setup'))
    .argument('[url|create]', 'an existing project URL, or create to make one')
    .option('--repo', 'save the setting in .claude/sessionstat.json, to commit for the team')
    .addOption(
      new Option('--global', 'deprecated: ~/.sessionstat/config.json is the default').hideHelp()
    )
    .action(async (choice: string | undefined, opts: { repo?: boolean; global?: boolean }) => {
      try {
        const meta = await getGitMetadata(deps.cwd(), deps.run)
        if (!meta.toplevel) throw new Error('Not inside a git repository')
        const result = await setupBoard(
          {
            repoRoot: meta.toplevel,
            choice,
            share: opts.repo ? true : opts.global ? false : undefined,
          },
          { run: deps.run, ask: deps.ask }
        )
        if (result.checks.length === 0) {
          deps.out(
            choice
              ? 'Nothing to do.'
              : 'Pass a project URL or `create`: sessionstat board setup create'
          )
        }
        for (const check of result.checks) {
          deps.out(`  ${!check.ok ? '✗' : check.warn ? '!' : '✓'} ${check.label}`)
          if (check.detail) deps.out(`      ${check.detail}`)
          if (check.fix && (!check.ok || check.warn)) deps.out(`      fix: ${check.fix}`)
        }
        if (!result.ok) deps.setExitCode(1)
      } catch (err) {
        fail(err)
      }
    })
  board
    .command('status')
    .description(commandDoc('board status'))
    .action(async () => {
      try {
        const healthy = await runBoardStatus({ run: deps.run, out: deps.out, cwd: deps.cwd() })
        if (!healthy) deps.setExitCode(1)
      } catch (err) {
        fail(err)
      }
    })
  board
    .command('resync')
    .description(commandDoc('board resync'))
    .option('--pr <number>', 'a PR number, instead of the current branch’s PR')
    .action(async (opts: { pr?: string }) => {
      try {
        const outcome = await runBoardResync(
          { run: deps.run, out: deps.out, cwd: deps.cwd() },
          opts
        )
        if (outcome.status === 'error') throw new Error(outcome.message)
        deps.out(
          outcome.status === 'updated'
            ? `✓ Wrote ${outcome.written.length} fields on ${outcome.url}`
            : `✓ Already up to date on ${outcome.url}`
        )
      } catch (err) {
        fail(err)
      }
    })

  const template = program.command('template').description('Work with the comment template')
  template
    .command('init')
    .description(commandDoc('template init'))
    .option(
      '--repo',
      'write <repo>/.claude/sessionstat.md, shared with the team, not ~/.sessionstat/template.md'
    )
    .option('--force', 'overwrite an existing file')
    .action(async (opts: { repo?: boolean; force?: boolean }) => {
      try {
        let target = paths.homeTemplate()
        if (opts.repo) {
          const meta = await getGitMetadata(deps.cwd(), deps.run)
          if (!meta.toplevel) throw new Error('Not inside a git repository')
          target = repoTemplatePath(meta.toplevel)
        }
        await mkdir(dirname(target), { recursive: true })
        try {
          await writeFile(target, DEFAULT_TEMPLATE, { flag: opts.force ? 'w' : 'wx' })
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`${target} already exists (--force to overwrite)`)
          }
          throw err
        }
        deps.out(`✓ Wrote ${target}`)
        deps.out(
          '  Edit it to change what is posted; `sessionstat template vars` shows the fields.'
        )
      } catch (err) {
        fail(err)
      }
    })
  template
    .command('vars')
    .description(commandDoc('template vars'))
    .option('--transcript <file...>', 'use these Claude transcripts instead of recorded sessions')
    .option('--all', 'include every sessionstat comment on the PR, from every author')
    .option('--no-pr', 'do not look up the PR')
    .action(async (opts: ViewOptions) => {
      try {
        const built = await currentBranchComment(deps, opts)
        deps.out(JSON.stringify(built.view, null, 2))
      } catch (err) {
        fail(err)
      }
    })

  for (const enable of [true, false]) {
    const name = enable ? 'enable' : 'disable'
    program
      .command(name)
      .description(commandDoc(name))
      .option('--global', 'everywhere it is installed, not just this repository')
      .action(async (opts: { global?: boolean }) => {
        try {
          const config = await loadConfig()
          if (opts.global) {
            await updateConfig({ enabled: enable })
            deps.out(`✓ sessionstat ${enable ? 'enabled' : 'disabled'} everywhere`)
            return
          }
          const meta = await getGitMetadata(deps.cwd(), deps.run)
          if (!meta.toplevel) throw new Error('Not inside a git repository (use --global)')
          const disabled = new Set(config.disabledRepos ?? [])
          if (enable) disabled.delete(meta.toplevel)
          else disabled.add(meta.toplevel)
          const next = await updateConfig({ disabledRepos: [...disabled] })
          deps.out(`✓ sessionstat ${enable ? 'enabled' : 'disabled'} for ${meta.toplevel}`)
          if (enable && !isEnabledFor(next, meta.toplevel)) {
            deps.out('  (still off everywhere: sessionstat enable --global)')
          }
        } catch (err) {
          fail(err)
        }
      })
  }

  program
    .command('config')
    .description(commandDoc('config'))
    .argument('[key]', 'setting to change: notice')
    .argument('[value]', 'on or off')
    .action(async (key?: string, value?: string) => {
      try {
        if (!key) {
          deps.out(JSON.stringify(await loadConfig(), null, 2))
          deps.out(`(${paths.config()})`)
          return
        }
        if (key !== 'notice') throw new Error(`Unknown setting "${key}". Settable: notice`)
        const on = ['on', 'true', 'yes'].includes(String(value).toLowerCase())
        const off = ['off', 'false', 'no'].includes(String(value).toLowerCase())
        if (!on && !off) throw new Error('Use: sessionstat config notice on|off')
        await updateConfig({ notice: on })
        deps.out(`✓ Start-of-session notice ${on ? 'on' : 'off'}`)
      } catch (err) {
        fail(err)
      }
    })

  program
    .command('logs')
    .description(commandDoc('logs'))
    .option('-n, --lines <n>', 'how many lines', '50')
    .option('--errors', 'only errors')
    .action(async (opts: { lines: string; errors?: boolean }) => {
      const n = Number.parseInt(opts.lines, 10) || 50
      let lines = await readLogTail(opts.errors ? 5000 : n)
      if (opts.errors) lines = lines.filter(l => l.includes('] ERROR: ')).slice(-n)
      if (lines.length === 0) deps.out(`(nothing logged yet in ${paths.logFile()})`)
      for (const line of lines) deps.out(line)
    })

  program
    .command('hook')
    .description(commandDoc('hook'))
    .action(async () => {
      // Normally intercepted in cli.ts before commander is built; kept so `--help` lists it.
      const { runHookFromStdin } = await import('./internal.js')
      await runHookFromStdin()
    })

  return program
}

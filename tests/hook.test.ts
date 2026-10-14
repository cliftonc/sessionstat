import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listChecks, queueChecks } from '../src/checks.js'
import { updateConfig } from '../src/config.js'
import { type HookDeps, handleHook, isPrTrigger, parseHookInput } from '../src/hook.js'
import { paths } from '../src/paths.js'
import { readSession } from '../src/sessions.js'
import { fakeGitHub } from './fake-gh.js'
import { fakeRunner, useTempHome } from './helpers.js'

const T0 = Date.parse('2026-10-14T09:00:00Z')
let env: Awaited<ReturnType<typeof useTempHome>>
let repo: string

beforeEach(async () => {
  env = await useTempHome()
  repo = join(env.home, 'work', 'app')
  await mkdir(repo, { recursive: true })
})
afterEach(async () => env.restore())

function stdin(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'sess-1',
    transcript_path: '/tmp/sess-1.jsonl',
    cwd: repo,
    hook_event_name: event,
    ...extra,
  })
}

function deps(
  overrides: Partial<HookDeps> = {},
  branch = 'feature/login',
  options: { head?: string; pr?: boolean } = {}
) {
  const out: string[] = []
  const github = fakeGitHub(options.pr === false ? { pr: null } : {})
  const d: HookDeps & { out: string[] } = {
    run: fakeRunner({
      repos: [{ root: repo, remote: 'git@github.com:acme/app.git', branch, head: options.head }],
      gh: github.gh,
    }),
    spawn: () => {},
    clock: () => T0,
    write: text => out.push(text),
    out,
    ...overrides,
  }
  return d
}

describe('hook stdin', () => {
  it('parses Claude Code hook JSON', () => {
    expect(
      parseHookInput(
        stdin('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git push' } })
      )
    ).toEqual({
      sessionId: 'sess-1',
      transcriptPath: '/tmp/sess-1.jsonl',
      cwd: repo,
      hookEvent: 'PostToolUse',
      toolName: 'Bash',
      command: 'git push',
    })
    expect(parseHookInput('not json')).toBeNull()
  })

  it('records the session to scratch', async () => {
    const result = await handleHook(stdin('Stop'), deps())
    expect(result.recorded).toBe(true)
    expect(await readSession('sess-1')).toMatchObject({
      sessionId: 'sess-1',
      transcriptPath: '/tmp/sess-1.jsonl',
      repoRoot: repo,
      remote: 'https://github.com/acme/app.git',
      branches: ['feature/login'],
    })
  })

  it('adds each branch the session works on, once', async () => {
    await handleHook(stdin('Stop'), deps())
    await handleHook(stdin('Stop', { n: 2 }), deps({}, 'feature/other'))
    await handleHook(stdin('Stop', { n: 3 }), deps({}, 'feature/login'))
    expect((await readSession('sess-1'))?.branches).toEqual(['feature/login', 'feature/other'])
  })

  it('records nothing outside a git repository, or where disabled', async () => {
    const outside = { ...deps(), run: fakeRunner({}) }
    expect((await handleHook(stdin('Stop'), outside)).recorded).toBe(false)
    await updateConfig({ disabledRepos: [repo] })
    expect((await handleHook(stdin('Stop', { n: 2 }), deps())).recorded).toBe(false)
    expect(await readSession('sess-1')).toBeNull()
  })
})

describe('what each event does', () => {
  const post = (r: string) => ['post-worker', '--repo', r, '--branch', 'feature/login']

  it('Stop posts in the background', async () => {
    const result = await handleHook(stdin('Stop'), deps())
    expect(result.spawned).toEqual([post(repo)])
  })

  it('PostToolUse posts only after a push or a PR command', async () => {
    const quiet = await handleHook(
      stdin('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }),
      deps()
    )
    expect(quiet.spawned).toEqual([])
    const push = await handleHook(
      stdin('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git push -u origin x' } }),
      deps()
    )
    expect(push.spawned).toEqual([post(repo)])
    expect(isPrTrigger('gh pr create --fill')).toBe(true)
    expect(isPrTrigger('echo git pushed')).toBe(false)
  })

  it('SessionEnd marks the end, queues checks and starts the poller', async () => {
    const result = await handleHook(stdin('SessionEnd'), deps())
    expect(result.spawned).toEqual([post(repo), ['poller']])
    expect((await readSession('sess-1'))?.endedAt).toBeDefined()
    const checks = await listChecks()
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ repoRoot: repo, branch: 'feature/login' })
    expect(checks[0].dueAt[0]).toBe(T0 + 5 * 60_000)
  })

  it('any hook, anywhere, starts a poller for overdue checks', async () => {
    await queueChecks('/somewhere/else', 'main', T0 - 60 * 60_000)
    const result = await handleHook(stdin('Stop'), deps())
    expect(result.spawned).toContainEqual(['poller'])
    // Not overdue: no poller.
    const fresh = await handleHook(stdin('Stop', { n: 2 }), deps({ clock: () => T0 - 59 * 60_000 }))
    expect(fresh.spawned).not.toContainEqual(['poller'])
  })

  it('a hook installed in both scopes does the work once', async () => {
    const d = deps()
    const [a, b] = await Promise.all([handleHook(stdin('Stop'), d), handleHook(stdin('Stop'), d)])
    expect([a.deduped, b.deduped].filter(Boolean)).toHaveLength(1)
    expect([...a.spawned, ...b.spawned]).toEqual([post(repo)])
    expect(await readdir(paths.dedupe())).toHaveLength(1)
  })

  it('the same payload later is a new event', async () => {
    await handleHook(stdin('Stop'), deps())
    const later = await handleHook(stdin('Stop'), deps({ clock: () => T0 + 6000 }))
    expect(later.deduped).toBeUndefined()
    expect(later.spawned).toHaveLength(1)
  })
})

describe('repositories without a GitHub remote', () => {
  it('records the session but spawns nothing and queues nothing', async () => {
    const d = deps()
    d.run = fakeRunner({ repos: [{ root: repo, remote: 'https://gitlab.com/acme/app' }] })
    const result = await handleHook(stdin('SessionEnd'), d)
    expect(result.recorded).toBe(true)
    expect(result.spawned).toEqual([])
    expect(await listChecks()).toEqual([])
  })
})

describe('build vs follow-up, and commits', () => {
  it('records at SessionStart whether the PR already existed', async () => {
    await handleHook(stdin('SessionStart'), deps())
    expect((await readSession('sess-1'))?.openedBeforePr).toBe(true)
  })

  it('records false when there was no PR, and keeps it when the PR appears later', async () => {
    await handleHook(stdin('SessionStart'), deps({}, 'feature/login', { pr: false }))
    expect((await readSession('sess-1'))?.openedBeforePr).toBe(false)
    await handleHook(stdin('SessionStart', { source: 'resume' }), deps())
    expect((await readSession('sess-1'))?.openedBeforePr).toBe(false)
  })

  it('leaves it unknown when gh could not answer', async () => {
    const slow = deps()
    slow.run = fakeRunner({
      repos: [{ root: repo, remote: 'https://github.com/acme/app', branch: 'feature/login' }],
      gh: () => ({ code: -1, stdout: '', stderr: '', timedOut: true }),
    })
    await handleHook(stdin('SessionStart'), slow)
    expect((await readSession('sess-1'))?.openedBeforePr).toBeUndefined()
  })

  it('records new HEADs seen at Stop, not the one the session started on', async () => {
    await handleHook(stdin('SessionStart'), deps({}, 'feature/login', { head: 'c0' }))
    await handleHook(stdin('Stop'), deps({}, 'feature/login', { head: 'c0' }))
    await handleHook(stdin('Stop', { n: 2 }), deps({}, 'feature/login', { head: 'c1' }))
    await handleHook(stdin('Stop', { n: 3 }), deps({}, 'feature/login', { head: 'c1' }))
    await handleHook(stdin('Stop', { n: 4 }), deps({}, 'feature/login', { head: 'c2' }))
    expect((await readSession('sess-1'))?.commits).toEqual([
      { branch: 'feature/login', sha: 'c1' },
      { branch: 'feature/login', sha: 'c2' },
    ])
  })
})

describe('SessionStart', () => {
  it('prints the notice as Claude Code systemMessage JSON, and records the session', async () => {
    const d = deps()
    const result = await handleHook(stdin('SessionStart'), d)
    expect(d.out).toHaveLength(1)
    expect(d.out[0].endsWith('\n')).toBe(true)
    expect(JSON.parse(d.out[0])).toEqual({
      systemMessage:
        'sessionstat: stats for this session will be added to PR #7 for feature/login (https://github.com/acme/app/pull/7)',
    })
    expect(result.recorded).toBe(true)
    expect(await readFile(join(paths.sessions(), 'sess-1.json'), 'utf-8')).toContain(
      'feature/login'
    )
  })
})

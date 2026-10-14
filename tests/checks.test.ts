import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CHECK_DELAYS_MS,
  hasDueChecks,
  listChecks,
  nextDueAt,
  queueChecks,
  runPoller,
  takeDueChecks,
} from '../src/checks.js'
import { paths } from '../src/paths.js'
import { recordSession } from '../src/sessions.js'
import { fakeGitHub } from './fake-gh.js'
import { FIXTURES, fakeRunner, useTempHome } from './helpers.js'

const MIN = 60_000
const T0 = Date.parse('2026-10-14T09:00:00Z')

let env: Awaited<ReturnType<typeof useTempHome>>
let repo: string

beforeEach(async () => {
  env = await useTempHome()
  repo = join(env.home, 'repo')
  await mkdir(repo, { recursive: true })
})
afterEach(async () => env.restore())

describe('the check queue', () => {
  it('schedules +5m, +30m and +2h', async () => {
    const check = await queueChecks(repo, 'feature/login', T0)
    expect(check.dueAt).toEqual([T0 + 5 * MIN, T0 + 30 * MIN, T0 + 120 * MIN])
    expect(CHECK_DELAYS_MS).toEqual([5 * MIN, 30 * MIN, 120 * MIN])
  })

  it('hands out each check once, when due, and gives up after the last', async () => {
    await queueChecks(repo, 'feature/login', T0)

    expect(await hasDueChecks(T0 + 4 * MIN)).toBe(false)
    expect(await takeDueChecks(T0 + 4 * MIN)).toEqual([])

    expect(await takeDueChecks(T0 + 5 * MIN)).toHaveLength(1)
    expect((await listChecks())[0].dueAt).toEqual([T0 + 30 * MIN, T0 + 120 * MIN])
    expect(await takeDueChecks(T0 + 6 * MIN)).toEqual([])
    expect(await nextDueAt()).toBe(T0 + 30 * MIN)

    // Slept through both remaining checks (laptop lid): one look, not two, and then done.
    expect(await takeDueChecks(T0 + 5 * 60 * MIN)).toHaveLength(1)
    expect(await listChecks()).toEqual([])
    expect(await nextDueAt()).toBeNull()
  })

  it('a new SessionEnd re-queues from now', async () => {
    await queueChecks(repo, 'b', T0)
    await queueChecks(repo, 'b', T0 + 60 * MIN)
    const checks = await listChecks()
    expect(checks).toHaveLength(1)
    expect(checks[0].dueAt[0]).toBe(T0 + 65 * MIN)
  })
})

describe('the poller, on a fake clock', () => {
  async function setup() {
    const transcript = join(env.home, 't.jsonl')
    await copyFile(join(FIXTURES, 'claude-code-synthetic.jsonl'), transcript)
    await recordSession({
      sessionId: 'synthetic-session-0001',
      transcriptPath: transcript,
      cwd: repo,
      repoRoot: repo,
      remote: 'https://github.com/acme/app',
      branch: 'feature/login',
    })
    await queueChecks(repo, 'feature/login', T0)
  }

  it('posts once the PR exists, then exits after the last check', async () => {
    await setup()
    const github = fakeGitHub({ pr: null })
    let now = T0
    const sleeps: number[] = []

    const ran = await runPoller({
      run: fakeRunner({ gh: github.gh }),
      clock: () => now,
      sleep: async ms => {
        sleeps.push(ms)
        now += ms
        // The user opens the PR 20 minutes after the session ended.
        if (now >= T0 + 20 * MIN && !github.state.pr) {
          github.state.pr = { number: 9, branch: 'feature/login' }
        }
      },
    })

    expect(ran).toBe(true)
    // +5m found nothing; +30m posted; +2h saw nothing new.
    expect(github.state.writes).toEqual(['POST repos/{owner}/{repo}/issues/9/comments'])
    expect(now).toBe(T0 + 120 * MIN)
    // It never sleeps more than a minute at a time, so checks queued meanwhile are seen.
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(MIN)
    expect(await listChecks()).toEqual([])
  })

  it('only one poller runs at a time', async () => {
    await setup()
    await mkdir(paths.locks(), { recursive: true })
    await writeFile(paths.pollerLock(), JSON.stringify({ pid: process.pid, at: T0 }))
    const ran = await runPoller({
      run: fakeRunner({ gh: fakeGitHub().gh }),
      clock: () => T0,
      sleep: async () => {},
    })
    expect(ran).toBe(false)
  })

  it('breaks the lock of a poller that died', async () => {
    await setup()
    await mkdir(paths.locks(), { recursive: true })
    // PID 2^22 + 1 is beyond any real pid_max default, so it is not running.
    await writeFile(paths.pollerLock(), JSON.stringify({ pid: 4194305, at: T0 }))
    let now = T0
    const ran = await runPoller({
      run: fakeRunner({ gh: fakeGitHub().gh }),
      clock: () => now,
      sleep: async ms => {
        now += ms
      },
    })
    expect(ran).toBe(true)
  })
})

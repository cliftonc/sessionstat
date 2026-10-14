import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { updateConfig } from '../src/config.js'
import { noticeFor, noticeJson } from '../src/notice.js'
import type { RunResult } from '../src/runner.js'
import { failed, fakeRunner, notFound, ok, useTempHome } from './helpers.js'

let env: Awaited<ReturnType<typeof useTempHome>>
let repo: string

beforeEach(async () => {
  env = await useTempHome()
  repo = join(env.home, 'app')
  await mkdir(repo, { recursive: true })
})
afterEach(async () => env.restore())

const github = (
  gh: () => RunResult | Promise<RunResult>,
  remote: string | null = 'https://github.com/acme/app'
) => fakeRunner({ repos: [{ root: repo, remote, branch: 'feature/x' }], gh })

const PR = ok(
  JSON.stringify({
    number: 12,
    url: 'https://github.com/acme/app/pull/12',
    headRefName: 'feature/x',
    state: 'OPEN',
  })
)

describe('the start-of-session notice', () => {
  it('names the PR when there is one', async () => {
    expect(
      await noticeFor(
        repo,
        github(() => PR)
      )
    ).toBe(
      'sessionstat: stats for this session will be added to PR #12 for feature/x (https://github.com/acme/app/pull/12)'
    )
  })

  it('is generic when there is no PR yet', async () => {
    expect(
      await noticeFor(
        repo,
        github(() => failed('no pull requests found for branch'))
      )
    ).toBe('sessionstat: stats for this session will be added to the PR for feature/x')
  })

  it('says how to fix a missing login or a missing gh', async () => {
    expect(
      await noticeFor(
        repo,
        github(() => failed('please run:  gh auth login', 4))
      )
    ).toBe("sessionstat: stats for this session won't be posted: run `gh auth login`")
    expect(
      await noticeFor(
        repo,
        github(() => notFound())
      )
    ).toContain('brew install gh')
  })

  it('falls back to the generic line when gh is slow', async () => {
    const run = github(() => ({ code: -1, stdout: '', stderr: '', timedOut: true }))
    expect(await noticeFor(repo, run, 50)).toBe(
      'sessionstat: stats for this session will be added to the PR for feature/x'
    )
    const prView = run.calls.find(c => c.cmd === 'gh')
    expect(prView?.options?.timeoutMs).toBe(50)
  })

  it('times out for real with the default runner', async () => {
    // A `gh` that hangs: the real runner kills it at the timeout and the generic line wins.
    const { runCommand } = await import('../src/runner.js')
    const started = Date.now()
    const result = await runCommand('sleep', ['5'], { timeoutMs: 100 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('says nothing outside a GitHub repository', async () => {
    expect(
      await noticeFor(
        join(env.home, 'nowhere'),
        github(() => PR)
      )
    ).toBeNull()
    expect(
      await noticeFor(
        repo,
        github(() => PR, 'https://gitlab.com/acme/app')
      )
    ).toBeNull()
    expect(
      await noticeFor(
        repo,
        github(() => PR, null)
      )
    ).toBeNull()
  })

  it('can be quietened with notice: false', async () => {
    await updateConfig({ notice: false })
    expect(
      await noticeFor(
        repo,
        github(() => PR)
      )
    ).toBeNull()
  })

  it('is one line of JSON', () => {
    expect(noticeJson('hi')).toBe('{"systemMessage":"hi"}\n')
  })
})

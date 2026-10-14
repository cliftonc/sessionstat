import { appendFile, copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { updateConfig } from '../src/config.js'
import { MARKER } from '../src/gh.js'
import { postForBranch, resolveOpenedBeforePr } from '../src/post.js'
import { recordSession } from '../src/sessions.js'
import {
  type DataSession,
  buildData,
  parseDataBlock,
  serializeDataBlock,
} from '../src/template/data.js'
import { fakeGitHub } from './fake-gh.js'
import { FIXTURES, fakeRunner, useTempHome } from './helpers.js'

let env: Awaited<ReturnType<typeof useTempHome>>
let repo: string
let transcript: string

beforeEach(async () => {
  env = await useTempHome()
  repo = join(env.home, 'repo')
  await mkdir(repo, { recursive: true })
  transcript = join(env.home, 'transcript.jsonl')
  await copyFile(join(FIXTURES, 'claude-code-synthetic.jsonl'), transcript)
  await recordSession({
    sessionId: 'synthetic-session-0001',
    transcriptPath: transcript,
    cwd: repo,
    repoRoot: repo,
    remote: 'https://github.com/acme/app',
    branch: 'feature/login',
    head: 'aaaa',
    openedBeforePr: false,
  })
  await recordSession({
    sessionId: 'synthetic-session-0001',
    transcriptPath: transcript,
    cwd: repo,
    repoRoot: repo,
    remote: 'https://github.com/acme/app',
    branch: 'feature/login',
    head: 'bbbb',
    recordCommit: true,
  })
})
afterEach(async () => env.restore())

describe('posting', () => {
  it('creates once, skips when unchanged, then edits the same comment', async () => {
    const github = fakeGitHub()
    const run = fakeRunner({ gh: github.gh })

    const first = await postForBranch(repo, 'feature/login', { run })
    expect(first.status).toBe('created')
    expect(github.state.comments).toHaveLength(1)
    const body = github.state.comments[0].body
    expect(body.startsWith(MARKER)).toBe(true)
    const data = parseDataBlock(body)
    expect(data?.sessions).toHaveLength(1)
    expect(data?.sessions[0]).toMatchObject({
      id: 'synthetic-session-0001',
      branch: 'feature/login',
      author: 'alice',
      openedBeforePr: false,
      commits: ['bbbb'],
      startedAt: '2026-10-01T09:00:05.000Z',
      endedAt: '2026-10-01T09:02:21.000Z',
    })

    // Nothing local changed: two gh reads (PR, login), no listing, no write.
    const before = run.calls.length
    const second = await postForBranch(repo, 'feature/login', { run })
    expect(second.status).toBe('unchanged')
    expect(run.calls.slice(before).map(c => c.args.slice(0, 2).join(' '))).toEqual([
      'pr view',
      'api user',
    ])

    // The session grows: the same comment is edited, not a second one added.
    await appendFile(
      transcript,
      `${JSON.stringify({
        type: 'user',
        uuid: 'later-1',
        sessionId: 'synthetic-session-0001',
        timestamp: '2026-10-01T10:00:00.000Z',
        message: { role: 'user', content: 'one more thing' },
      })}\n`
    )
    const third = await postForBranch(repo, 'feature/login', { run })
    expect(third.status).toBe('updated')
    expect(github.state.comments).toHaveLength(1)
    expect(github.state.writes).toEqual([
      'POST repos/{owner}/{repo}/issues/7/comments',
      'PATCH repos/{owner}/{repo}/issues/comments/1000',
    ])
    expect(github.state.comments[0].body).toContain('3 prompts')
  })

  it('merges into the existing data block: block-only sessions are kept, local ones replaced', async () => {
    const github = fakeGitHub()
    const elsewhere = {
      ...parseDataBlockFromLocal(),
      id: 'from-another-machine',
      startedAt: '2026-09-30T09:00:00.000Z',
      endedAt: '2026-09-30T10:00:00.000Z',
      turns: 11,
    }
    const staleLocal = { ...parseDataBlockFromLocal(), turns: 999 }
    github.state.comments.push({
      id: 55,
      user: { login: 'alice' },
      body: `${MARKER}\nold\n${serializeDataBlock(buildData([elsewhere, staleLocal], 'feature/login'))}`,
    })

    const outcome = await postForBranch(repo, 'feature/login', {
      run: fakeRunner({ gh: github.gh }),
    })
    expect(outcome).toMatchObject({ status: 'updated', commentId: 55 })
    const data = parseDataBlock(github.state.comments[0].body)
    expect(data?.sessions.map(s => [s.id, s.turns])).toEqual([
      ['from-another-machine', 11],
      ['synthetic-session-0001', 2],
    ])
    // The rendered view comes from the merged set too.
    expect(github.state.comments[0].body).toContain('**2 sessions**')
    expect(data?.totals.turns).toBe(13)
  })

  it("leaves another contributor's comment alone and creates its own", async () => {
    const github = fakeGitHub()
    const bobs = `${MARKER}\nbob's stats\n${serializeDataBlock(buildData([], 'feature/login'))}`
    github.state.comments.push({ id: 77, user: { login: 'bob' }, body: bobs })

    const outcome = await postForBranch(repo, 'feature/login', {
      run: fakeRunner({ gh: github.gh }),
    })
    expect(outcome.status).toBe('created')
    expect(github.state.comments).toHaveLength(2)
    expect(github.state.comments[0].body).toBe(bobs)
    expect(github.state.comments[1].user.login).toBe('alice')
    expect(github.state.writes).toEqual(['POST repos/{owner}/{repo}/issues/7/comments'])
  })

  it('does nothing without a PR, without a login, or when disabled', async () => {
    const noPr = fakeGitHub({ pr: null })
    expect(
      await postForBranch(repo, 'feature/login', { run: fakeRunner({ gh: noPr.gh }) })
    ).toEqual({
      status: 'no-pr',
      lookup: 'none',
    })

    const loggedOut = fakeGitHub()
    loggedOut.state.authenticated = false
    const out = await postForBranch(repo, 'feature/login', {
      run: fakeRunner({ gh: loggedOut.gh }),
    })
    expect(out).toEqual({ status: 'no-pr', lookup: 'not-authenticated' })

    await updateConfig({ disabledRepos: [repo] })
    const github = fakeGitHub()
    const disabled = await postForBranch(repo, 'feature/login', {
      run: fakeRunner({ gh: github.gh }),
    })
    expect(disabled.status).toBe('disabled')
    expect(github.state.writes).toEqual([])
  })

  it('has nothing to post on a branch no session worked on', async () => {
    const github = fakeGitHub()
    const outcome = await postForBranch(repo, 'other', { run: fakeRunner({ gh: github.gh }) })
    expect(outcome.status).toBe('no-sessions')
  })
})

describe('build or follow-up', () => {
  const started = { startedAt: new Date('2026-10-01T10:00:00Z') }
  it('uses what SessionStart recorded', () => {
    expect(resolveOpenedBeforePr({ openedBeforePr: true }, started, null)).toBe(true)
    expect(
      resolveOpenedBeforePr({ openedBeforePr: false }, started, {
        createdAt: '2026-01-01T00:00:00Z',
      })
    ).toBe(false)
  })
  it('falls back to the PR creation time when SessionStart did not know', () => {
    expect(resolveOpenedBeforePr({}, started, { createdAt: '2026-10-01T09:00:00Z' })).toBe(true)
    expect(resolveOpenedBeforePr({}, started, { createdAt: '2026-10-01T11:00:00Z' })).toBe(false)
    expect(resolveOpenedBeforePr({}, started, null)).toBe(false)
  })
})

/** A DataSession shaped like the local one, for seeding a comment's block. */
function parseDataBlockFromLocal(): DataSession {
  return {
    id: 'synthetic-session-0001',
    branch: 'feature/login',
    author: 'alice',
    model: 'claude-opus-5-5',
    startedAt: '2026-10-01T09:00:05.000Z',
    endedAt: '2026-10-01T09:02:21.000Z',
    durationMs: 136000,
    openedBeforePr: false,
    commits: [],
    turns: 2,
    toolCalls: 7,
    toolResults: 7,
    tools: [],
    files: [],
    filesEdited: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    billing: 'unknown',
    valueUsd: null,
    costUsd: null,
    errors: 0,
    interruptions: 0,
    compactions: 0,
    testRuns: { passed: 0, failed: 0 },
    successRate: 0,
    processQuality: 0,
    iterations: 0,
    linesAdded: null,
    linesRemoved: null,
  }
}

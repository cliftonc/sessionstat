import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadBoardCache, syncBoard } from '../src/board/board.js'
import { fieldValues, mainModel } from '../src/board/fields.js'
import {
  loadBoardSettings,
  parseProjectUrl,
  repoSettingsPath,
  repoSlug,
} from '../src/board/settings.js'
import { setupBoard } from '../src/board/setup.js'
import { loadConfig, updateConfig } from '../src/config.js'
import { MARKER } from '../src/gh.js'
import { postForBranch } from '../src/post.js'
import { recordSession } from '../src/sessions.js'
import { type DataSession, buildData, serializeDataBlock } from '../src/template/data.js'
import { fakeProjects } from './fake-board.js'
import { fakeGitHub } from './fake-gh.js'
import { FIXTURES, fakeRunner, useTempHome } from './helpers.js'

let env: Awaited<ReturnType<typeof useTempHome>>
let repo: string

beforeEach(async () => {
  env = await useTempHome()
  repo = join(env.home, 'repo')
  await mkdir(repo, { recursive: true })
})
afterEach(async () => env.restore())

function session(over: Partial<DataSession> = {}): DataSession {
  return {
    id: 's1',
    branch: 'feature/login',
    author: 'alice',
    model: 'claude-opus-5-5',
    startedAt: '2026-10-01T09:00:00.000Z',
    endedAt: '2026-10-01T09:30:00.000Z',
    durationMs: 30 * 60_000,
    openedBeforePr: false,
    commits: [],
    turns: 4,
    toolCalls: 10,
    toolResults: 10,
    tools: [],
    files: [],
    filesEdited: 0,
    tokens: { input: 1_000_000, output: 200_000, cacheRead: 300_000, cacheWrite: 0 },
    billing: 'api',
    valueUsd: 2.5,
    costUsd: 2.5,
    errors: 1,
    interruptions: 1,
    compactions: 0,
    testRuns: { passed: 0, failed: 0 },
    successRate: 90,
    processQuality: 80,
    iterations: 1,
    linesAdded: null,
    linesRemoved: null,
    ...over,
  }
}

const BOARD = { owner: 'acme', number: 7 }
const PR = { id: 'PR_7', number: 7 }

function setupFake() {
  const projects = fakeProjects()
  const project = projects.addProject('acme', 7)
  const run = fakeRunner({ gh: fakeGitHub({ graphql: projects.graphql }).gh })
  return { projects, project, run }
}

describe('board fields', () => {
  it('totals every session, split into build and follow-up', () => {
    const values = Object.fromEntries(
      fieldValues([
        session(),
        session({
          id: 's2',
          openedBeforePr: true,
          durationMs: 10 * 60_000,
          endedAt: '2026-10-03T10:00:00Z',
        }),
      ]).map(f => [f.name, f.value])
    )
    expect(values).toMatchObject({
      'Agent sessions': 2,
      'Agent active minutes': 40,
      'Agent turns': 8,
      'Agent tokens (M)': 3,
      'Agent cost (USD)': 5,
      'Agent errors': 4,
      'Agent model': 'claude-opus-5-5',
      'Agent last session': '2026-10-03',
      'Agent build sessions': 1,
      'Agent follow-up sessions': 1,
      'Agent follow-up minutes': 10,
      'Agent follow-up cost (USD)': 2.5,
    })
  })

  it('takes a prefix and a subset, and leaves cost alone on a subscription', () => {
    const fields = fieldValues([session({ billing: 'subscription', costUsd: null })], {
      prefix: 'AI ',
      fields: ['sessions', 'cost'],
    })
    expect(fields.map(f => [f.name, f.value])).toEqual([
      ['AI sessions', 1],
      ['AI cost (USD)', null],
    ])
  })

  it('picks the model with the most session time', () => {
    expect(
      mainModel([
        session({ model: 'a', durationMs: 5 }),
        session({ model: 'b', durationMs: 3 }),
        session({ model: 'b', durationMs: 3 }),
      ])
    ).toBe('b')
  })

  it('parses project URLs and remotes', () => {
    expect(parseProjectUrl('https://github.com/orgs/acme/projects/7/views/1')).toEqual(BOARD)
    expect(parseProjectUrl('https://github.com/users/alice/projects/3')).toEqual({
      owner: 'alice',
      number: 3,
    })
    expect(parseProjectUrl('https://example.com')).toBeNull()
    expect(repoSlug('git@github.com:acme/app.git')).toBe('acme/app')
    expect(repoSlug('https://github.com/acme/app')).toBe('acme/app')
  })
})

describe('syncBoard', () => {
  it('creates missing fields, adds the PR and writes its values', async () => {
    const { projects, project, run } = setupFake()
    const outcome = await syncBoard(run, repo, {
      slug: 'acme/app',
      board: BOARD,
      pr: PR,
      sessions: [session()],
    })
    expect(outcome.status).toBe('updated')
    expect(project.fields.map(f => f.name)).toContain('Agent cost (USD)')
    expect(projects.valuesFor(project, 'PR_7')).toMatchObject({
      'Agent sessions': 1,
      'Agent model': 'claude-opus-5-5',
      'Agent last session': '2026-10-01',
    })
    // One batched write for all the values.
    expect(projects.state.operations.filter(o => o === 'SessionstatSetValues')).toHaveLength(1)
  })

  it('uses the cached ids and skips values that have not changed', async () => {
    const { projects, run } = setupFake()
    const input = { slug: 'acme/app', board: BOARD, pr: PR, sessions: [session()] }
    await syncBoard(run, repo, input)
    projects.state.operations = []

    expect((await syncBoard(run, repo, input)).status).toBe('unchanged')
    expect(projects.state.operations).toEqual([])

    const more = await syncBoard(run, repo, {
      ...input,
      sessions: [session(), session({ id: 's2', startedAt: '2026-10-01T09:00:00.000Z' })],
    })
    expect(more.status === 'updated' && more.written).toContain('Agent sessions')
    expect(more.status === 'updated' && more.written).not.toContain('Agent model')
    expect(projects.state.operations).toEqual(['SessionstatSetValues'])
  })

  it('refetches and retries once when a cached id has gone', async () => {
    const { projects, project, run } = setupFake()
    const input = { slug: 'acme/app', board: BOARD, pr: PR, sessions: [session()] }
    await syncBoard(run, repo, input)
    project.items.clear() // someone removed the PR from the board

    const outcome = await syncBoard(run, repo, { ...input, sessions: [session({ turns: 9 })] })
    expect(outcome.status).toBe('updated')
    expect(projects.valuesFor(project, 'PR_7')?.['Agent turns']).toBe(9)
    // A fresh start writes every field, not just the changed one.
    expect(projects.valuesFor(project, 'PR_7')?.['Agent sessions']).toBe(1)
  })

  it('adds a new model as an option, keeping the existing ones', async () => {
    const { project, projects, run } = setupFake()
    const input = { slug: 'acme/app', board: BOARD, pr: PR, sessions: [session()] }
    await syncBoard(run, repo, input)
    const field = project.fields.find(f => f.name === 'Agent model')
    const firstId = field?.options?.[0].id

    await syncBoard(run, repo, { ...input, sessions: [session({ model: 'claude-sonnet-5-5' })] })
    expect(field?.options?.map(o => o.name)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(field?.options?.[0].id).toBe(firstId)
    expect(projects.valuesFor(project, 'PR_7')?.['Agent model']).toBe('claude-sonnet-5-5')
  })

  it('leaves a same-named field of another type alone', async () => {
    const { project, projects, run } = setupFake()
    project.fields.push({ id: 'F_mine', name: 'Agent turns', dataType: 'TEXT' })
    const outcome = await syncBoard(run, repo, {
      slug: 'acme/app',
      board: BOARD,
      pr: PR,
      sessions: [session()],
    })
    expect(outcome.status).toBe('updated')
    expect(project.fields.filter(f => f.name === 'Agent turns')).toHaveLength(1)
    expect(projects.valuesFor(project, 'PR_7')?.['Agent turns']).toBeUndefined()
  })

  it('reports a missing scope with the fix, and records it for status', async () => {
    const { projects, run } = setupFake()
    projects.state.failWrites = {
      type: 'INSUFFICIENT_SCOPES',
      message: "Your token has not been granted the required scopes: 'project'",
    }
    const outcome = await syncBoard(run, repo, {
      slug: 'acme/app',
      board: BOARD,
      pr: PR,
      sessions: [session()],
    })
    expect(outcome.status === 'error' && outcome.message).toContain('gh auth refresh -s project')
    expect((await loadBoardCache())['acme/app']?.lastError).toContain('scopes')
  })
})

describe('posting with a board', () => {
  let transcript: string
  beforeEach(async () => {
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
    await mkdir(dirname(repoSettingsPath(repo)), { recursive: true })
    await writeFile(repoSettingsPath(repo), JSON.stringify({ board: BOARD }))
    await updateConfig({ boards: { 'acme/app': BOARD } })
  })

  it('writes the totals over every author’s sessions after posting', async () => {
    const projects = fakeProjects()
    const project = projects.addProject('acme', 7)
    const github = fakeGitHub({ graphql: projects.graphql })
    // Bob has already posted his own comment with one session.
    github.state.comments.push({
      id: 1,
      body: `${MARKER}\nstats\n${serializeDataBlock(buildData([session({ id: 'bob-1', author: 'bob' })], 'feature/login'))}`,
      user: { login: 'bob' },
    })

    const outcome = await postForBranch(repo, 'feature/login', {
      run: fakeRunner({ gh: github.gh }),
    })
    expect(outcome.status).toBe('created')
    expect(outcome.status === 'created' && outcome.board?.status).toBe('updated')
    expect(projects.valuesFor(project, 'PR_7')?.['Agent sessions']).toBe(2)
  })

  it('writes nothing to a board the repository names that the user has not accepted', async () => {
    // Someone's branch points the shared setting at another board, with their own prefix.
    const evil = { owner: 'acme', number: 8, prefix: 'Pwned ' }
    await writeFile(repoSettingsPath(repo), JSON.stringify({ board: evil }))
    const projects = fakeProjects()
    const own = projects.addProject('acme', 7)
    const other = projects.addProject('acme', 8)
    const github = fakeGitHub({ graphql: projects.graphql })

    const outcome = await postForBranch(repo, 'feature/login', {
      run: fakeRunner({ gh: github.gh }),
    })
    expect(outcome.status).toBe('created')
    expect(other.fields.map(f => f.name)).not.toContain('Pwned sessions')
    expect(projects.valuesFor(other, 'PR_7')).toBeUndefined()
    // The user's own setting is still used.
    expect(projects.valuesFor(own, 'PR_7')?.['Agent sessions']).toBe(1)
  })

  it('writes nothing when only the repository names a board', async () => {
    await updateConfig({ boards: {} })
    const projects = fakeProjects()
    const project = projects.addProject('acme', 7)
    const github = fakeGitHub({ graphql: projects.graphql })
    const outcome = await postForBranch(repo, 'feature/login', {
      run: fakeRunner({ gh: github.gh }),
    })
    expect(outcome.status).toBe('created')
    expect(outcome.status === 'created' && outcome.board).toBeUndefined()
    expect(projects.state.operations).toEqual([])
    expect(project.fields.map(f => f.name)).toEqual(['Status'])
  })

  it('still posts the comment when the board cannot be written', async () => {
    const github = fakeGitHub({ graphql: fakeProjects().graphql }) // project 7 does not exist
    const outcome = await postForBranch(repo, 'feature/login', {
      run: fakeRunner({ gh: github.gh }),
    })
    expect(outcome.status).toBe('created')
    expect(outcome.status === 'created' && outcome.board?.status).toBe('error')
    expect(github.state.comments).toHaveLength(1)
  })
})

describe('board setup', () => {
  function setupRunner(scopes?: string[] | null) {
    const projects = fakeProjects()
    const github = fakeGitHub({ graphql: projects.graphql, scopes })
    const run = fakeRunner({
      repos: [{ root: repo, remote: 'https://github.com/acme/app', branch: 'main' }],
      gh: github.gh,
    })
    return { projects, run }
  }
  const answers = (...replies: string[]) => {
    const asked: string[] = []
    return {
      asked,
      ask: async (q: string) => {
        asked.push(q)
        return replies.shift() ?? ''
      },
    }
  }

  it('walks through creating the board: fields, link, setting saved in config.json', async () => {
    const { projects, run } = setupRunner()
    const { ask, asked } = answers('y', '', '')
    const result = await setupBoard({ repoRoot: repo }, { run, ask })

    expect(asked).toHaveLength(3)
    expect(result.ok).toBe(true)
    const [project] = projects.state.projects
    expect(project.title).toBe('sessionstat: acme/app')
    expect(project.linked).toEqual(['R_app'])
    expect(project.fields.map(f => f.name)).toContain('Agent sessions')
    expect((await loadConfig()).boards?.['acme/app']).toMatchObject({
      owner: 'acme',
      number: 1,
      url: project.url,
    })
    await expect(stat(repoSettingsPath(repo))).rejects.toThrow()
    await expect(stat(join(repo, '.sessionstat.json'))).rejects.toThrow()
  })

  it('shares the setting in .claude/sessionstat.json when asked to', async () => {
    const { projects, run } = setupRunner()
    const result = await setupBoard({ repoRoot: repo }, { run, ...answers('y', '', 'y') })
    expect(result.ok).toBe(true)
    const saved = JSON.parse(await readFile(repoSettingsPath(repo), 'utf-8'))
    expect(saved.board).toMatchObject({ owner: 'acme', number: 1 })
    expect(repoSettingsPath(repo)).toBe(join(repo, '.claude', 'sessionstat.json'))
    // Kept in config.json too: that is what makes the shared file trusted here.
    expect((await loadConfig()).boards?.['acme/app']).toMatchObject({ owner: 'acme', number: 1 })
    expect(projects.state.projects).toHaveLength(1)
  })

  it('still reads a board from the older <repo>/.sessionstat.json', async () => {
    await writeFile(join(repo, '.sessionstat.json'), JSON.stringify({ board: BOARD }))
    await updateConfig({ boards: { 'acme/app': BOARD } })
    const loaded = await loadBoardSettings(repo, 'acme/app')
    expect(loaded).toEqual({ board: BOARD, source: join(repo, '.sessionstat.json') })
  })

  it('reuses an existing board of the same name rather than making a second', async () => {
    const { projects, run } = setupRunner()
    projects.addProject('acme', 4, 'sessionstat: acme/app')
    await setupBoard({ repoRoot: repo, choice: 'create' }, { run })
    expect(projects.state.projects).toHaveLength(1)
    expect(projects.state.operations).not.toContain('SessionstatCreateProject')
  })

  it('uses a pasted project URL', async () => {
    const { projects, run } = setupRunner()
    const existing = projects.addProject('acme', 9)
    const { ask } = answers('yes', 'https://github.com/orgs/acme/projects/9')
    expect((await setupBoard({ repoRoot: repo }, { run, ask })).ok).toBe(true)
    expect(existing.fields.length).toBeGreaterThan(10)
  })

  it('asks nothing and does nothing when there is no one to ask', async () => {
    const { projects, run } = setupRunner()
    const result = await setupBoard({ repoRoot: repo }, { run })
    expect(result.checks).toEqual([])
    expect(projects.state.operations).toEqual([])
  })

  it('takes no for an answer', async () => {
    const { projects, run } = setupRunner()
    const result = await setupBoard({ repoRoot: repo }, { run, ...answers('') })
    expect(result.checks.map(c => c.label)).toEqual(['Project board: not set up'])
    expect(projects.state.operations).toEqual([])
  })

  it('stops with the fix when the token lacks the project scope', async () => {
    const { projects, run } = setupRunner(['repo'])
    const result = await setupBoard({ repoRoot: repo, choice: 'create' }, { run })
    expect(result.ok).toBe(false)
    expect(result.checks[0].fix).toBe('gh auth refresh -s project')
    expect(projects.state.operations).toEqual([])
  })

  it('asks before using a board the repository names, and remembers the answer', async () => {
    const { projects, run } = setupRunner()
    const project = projects.addProject('acme', 7)
    await mkdir(dirname(repoSettingsPath(repo)), { recursive: true })
    await writeFile(repoSettingsPath(repo), JSON.stringify({ board: BOARD }))
    const { ask, asked } = answers('y')
    expect((await setupBoard({ repoRoot: repo }, { run, ask })).ok).toBe(true)
    expect(asked[0]).toContain('names the project board')
    expect(project.fields.map(f => f.name)).toContain('Agent turns')
    expect((await loadBoardSettings(repo, 'acme/app'))?.source).toBe(repoSettingsPath(repo))
  })

  it('leaves a board the repository names alone when the user declines, or cannot be asked', async () => {
    const { projects, run } = setupRunner()
    projects.addProject('acme', 7)
    await mkdir(dirname(repoSettingsPath(repo)), { recursive: true })
    await writeFile(repoSettingsPath(repo), JSON.stringify({ board: BOARD }))
    for (const deps of [{ run, ...answers('n') }, { run }]) {
      const result = await setupBoard({ repoRoot: repo }, deps)
      expect(result.checks.map(c => c.label)).toEqual([
        'Project board in .claude/sessionstat.json not used: https://github.com/orgs/acme/projects/7',
      ])
    }
    expect(projects.state.operations).toEqual([])
    expect(await loadBoardSettings(repo, 'acme/app')).toBeNull()
  })

  it('accepts a shared board given by its URL', async () => {
    const { projects, run } = setupRunner()
    const project = projects.addProject('acme', 7)
    await mkdir(dirname(repoSettingsPath(repo)), { recursive: true })
    await writeFile(repoSettingsPath(repo), JSON.stringify({ board: { ...BOARD, prefix: 'AI ' } }))
    const result = await setupBoard(
      { repoRoot: repo, choice: 'https://github.com/orgs/acme/projects/7' },
      { run }
    )
    expect(result.ok).toBe(true)
    expect(project.fields.map(f => f.name)).toContain('AI turns')
    expect((await loadBoardSettings(repo, 'acme/app'))?.source).toBe(repoSettingsPath(repo))
  })

  it('re-checks an existing board instead of asking', async () => {
    const { projects, run } = setupRunner()
    const project = projects.addProject('acme', 7)
    await mkdir(dirname(repoSettingsPath(repo)), { recursive: true })
    await writeFile(repoSettingsPath(repo), JSON.stringify({ board: BOARD }))
    await updateConfig({ boards: { 'acme/app': BOARD } })
    const { ask, asked } = answers()
    const result = await setupBoard({ repoRoot: repo }, { run, ask })
    expect(asked).toEqual([])
    expect(result.ok).toBe(true)
    expect(project.fields.map(f => f.name)).toContain('Agent turns')
  })
})

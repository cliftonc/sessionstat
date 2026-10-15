import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MARKER } from '../src/gh.js'
import { computeSessionStats } from '../src/metrics/index.js'
import { paths } from '../src/paths.js'
import { type DataSession, buildData, toDataSession } from '../src/template/data.js'
import { renderComment, resolveTemplate } from '../src/template/render.js'
import { type CommentView, buildView, formatDuration, formatTokens } from '../src/template/view.js'
import { FIXTURES, useTempHome } from './helpers.js'

let env: Awaited<ReturnType<typeof useTempHome>>
let repo: string

async function sessionsFor(...fixtures: string[]): Promise<DataSession[]> {
  const sessions: DataSession[] = []
  for (const f of fixtures) {
    const { stats } = await computeSessionStats(await readFile(join(FIXTURES, f), 'utf-8'))
    sessions.push(
      toDataSession(stats, {
        branch: 'feature/login',
        author: 'alice',
        repoRoot: '/tmp/example-repo',
        openedBeforePr: f.includes('sample-2'),
        commits: f.includes('synthetic') ? ['0123456789abcdef'] : [],
        billing: f.includes('synthetic') ? 'subscription' : 'api',
      })
    )
  }
  return sessions
}

let current: DataSession[] = []

async function viewFor(...fixtures: string[]): Promise<CommentView> {
  current = await sessionsFor(...fixtures)
  return buildView({
    sessions: current,
    pr: { number: 42, url: 'https://github.com/acme/app/pull/42', headRefName: 'feature/login' },
    repo: 'acme/app',
    branch: 'feature/login',
    now: new Date('2026-10-14T12:00:00Z'),
  })
}

const render = (view: CommentView, root: string) =>
  renderComment(view, root, buildData(current, 'feature/login'))

beforeEach(async () => {
  env = await useTempHome()
  repo = join(env.home, 'repo')
  await mkdir(repo, { recursive: true })
})
afterEach(async () => env.restore())

describe('default template', () => {
  it('renders one session', async () => {
    const { body, source } = await render(await viewFor('claude-code-synthetic.jsonl'), repo)
    expect(source).toBe('default')
    expect(body).toMatchInlineSnapshot(`
      "<!-- sessionstat -->
      ### Claude Code · 1 session · 2m

      | Time | Prompts | Tool calls | Files | Commits | Tokens | Billed | API value |
      |:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
      | **2m** | **2** | **7** | **2** | **1** | **1.3M** | **plan** | **$3.41** |

      | Session | Model | Started | Input | Output | Cache read | Cache write |
      |---|---|---|--:|--:|--:|--:|
      | \`syntheti\` alice | Opus 5.5 | Oct 01 09:00 | 1.2k | 45k | 1.2M | 80k |

      <sub>Before the PR was opened. Billed "plan": covered by a Claude subscription.</sub>

      **Quality** · 86% tool success · tests: 1 passed, **1 failed** · tool errors: 1 · interruptions: 1 · compactions: 1

      <sub>Posted by [sessionstat](https://www.npmjs.com/package/sessionstat) · updated 2026-10-14 12:00 UTC</sub>

      <!-- sessionstat:data {"v":1,"branch":"feature/login","sessions":[{"id":"synthetic-session-0001","branch":"feature/login","author":"alice","model":"claude-opus-5-5","startedAt":"2026-10-01T09:00:05.000Z","endedAt":"2026-10-01T09:02:21.000Z","durationMs":136000,"openedBeforePr":false,"commits":["0123456789abcdef"],"turns":2,"toolCalls":7,"toolResults":7,"tools":[{"name":"Bash","count":3},{"name":"Edit","count":2},{"name":"Read","count":1},{"name":"Write","count":1}],"files":["src/login.ts","tests/login.test.ts"],"filesEdited":2,"tokens":{"input":1200,"output":45000,"cacheRead":1200000,"cacheWrite":80000},"billing":"subscription","valueUsd":3.4112,"costUsd":null,"errors":1,"interruptions":1,"compactions":1,"testRuns":{"passed":1,"failed":1},"successRate":86,"processQuality":50,"iterations":1,"linesAdded":42,"linesRemoved":3}],"totals":{"sessions":1,"durationMs":136000,"turns":2,"toolCalls":7,"toolResults":7,"filesEdited":2,"commits":1,"tokens":{"input":1200,"output":45000,"cacheRead":1200000,"cacheWrite":80000},"costUsd":null,"costPartial":false,"valueUsd":3.4112,"valuePartial":false,"billing":{"subscription":1,"api":0,"unknown":0},"errors":1,"interruptions":1,"compactions":1,"testRuns":{"passed":1,"failed":1},"successRate":86}} -->
      "
    `)
  })

  it('splits build sessions from follow-up sessions', async () => {
    const view = await viewFor('claude-code-sample-1.jsonl', 'claude-code-sample-2.jsonl')
    expect(view.buildSessions.map(s => s.shortId)).toEqual(['b1a1efd7'])
    expect(view.followUpSessions.map(s => s.shortId)).toEqual(['a8f46efe'])
    expect(view.followUpSessions[0].phase).toBe('follow-up')
    expect(view.hasBuild && view.hasFollowUp).toBe(true)
    const { body } = await render(view, repo)
    expect(view.bothPhases).toBe(true)
    expect(view.phaseSummary).toBe('1 build, 1 follow-up')
    expect(view.groups.map(g => g.label)).toEqual(['Build', 'Follow-up'])
    expect(body).toContain('| **Build** | | | | | | |')
    expect(body).toContain('| **Follow-up** | | | | | | |')
    expect(body).toContain('#### Activity')
    expect(body).toContain('#### Tokens and cost')
    expect(body).toContain('Build: before the PR was opened; follow-up: after.')
  })

  it('leaves out the group rows when every session is in one phase', async () => {
    const view = await viewFor('claude-code-sample-1.jsonl', 'claude-code-synthetic.jsonl')
    expect(view.bothPhases).toBe(false)
    const { body } = await render(view, repo)
    expect(body).not.toContain('| **Build** |')
    expect(body).not.toContain('Build: before the PR was opened')
  })

  it('draws every session on one timeline', async () => {
    const view = await viewFor('claude-code-sample-1.jsonl', 'claude-code-sample-2.jsonl')
    const bars = view.sessions.map(s => s.timeline)
    expect(bars).toHaveLength(2)
    for (const bar of bars) expect(bar.replace(/\\\|/g, '|')).toHaveLength(24)
    const { body } = await render(view, repo)
    expect(body).toContain(`| ${view.timeline.from} → ${view.timeline.to} |`)
    for (const bar of bars) expect(body).toContain(`\`${bar}\``)
  })

  it('exposes commits per session', async () => {
    const view = await viewFor('claude-code-synthetic.jsonl')
    expect(view.sessions[0].commits).toEqual([{ sha: '0123456789abcdef', short: '0123456' }])
    expect(view.totals.commits).toBe(1)
  })

  it('folds several sessions into <details> and flags a partial cost', async () => {
    const view = await viewFor('claude-code-sample-1.jsonl', 'claude-code-synthetic.jsonl')
    expect(view.multipleSessions).toBe(true)
    expect(view.totals.costPartial).toBe(true)
    expect(view.totals.valuePartial).toBe(true)
    const { body } = await render(view, repo)
    expect(body).toContain('<details>')
    expect(body).toContain('### Claude Code · 2 sessions')
    expect(body).toContain("Some sessions' spend is unknown.")
    expect(body).toContain('Some sessions are unpriced.')
    expect(body).toContain('| **plan** | **$3.41** |')
    // An API-billed session on a model with no published rate: neither figure is guessed.
    expect(body).toMatch(/\| `b1a1efd7` \S+ \|(?: [^|]+ \|){6} – \| – \|/)
  })

  it('hides cost entirely when no session has one yet', async () => {
    const view = await viewFor('claude-code-sample-2.jsonl')
    expect(view.hasCost).toBe(false)
    const { body } = await render(view, repo)
    expect(body).toContain('| **–** | **–** |')
    expect(body).not.toContain('$')
  })
})

describe('template precedence', () => {
  it('repo beats home beats default', async () => {
    expect((await resolveTemplate(repo)).source).toBe('default')

    await mkdir(paths.homeTemplate().replace(/\/[^/]+$/, ''), { recursive: true })
    await writeFile(paths.homeTemplate(), 'HOME {{repo}}')
    expect((await resolveTemplate(repo)).source).toBe('home')

    await writeFile(join(repo, '.sessionstat.md'), 'REPO {{repo}}')
    const resolved = await resolveTemplate(repo)
    expect(resolved).toMatchObject({ source: 'repo', path: join(repo, '.sessionstat.md') })

    const { body } = await render(await viewFor('claude-code-synthetic.jsonl'), repo)
    expect(body.startsWith(`${MARKER}\nREPO acme/app\n\n<!-- sessionstat:data {`)).toBe(true)
    // Another repository without its own file gets the home template.
    const other = join(env.home, 'other')
    const { body: otherBody } = await render(await viewFor('claude-code-synthetic.jsonl'), other)
    expect(otherBody.startsWith(`${MARKER}\nHOME acme/app\n`)).toBe(true)
  })

  it('.claude/sessionstat.md beats the older root .sessionstat.md', async () => {
    await writeFile(join(repo, '.sessionstat.md'), 'OLD')
    await mkdir(join(repo, '.claude'), { recursive: true })
    await writeFile(join(repo, '.claude', 'sessionstat.md'), 'NEW')
    expect(await resolveTemplate(repo)).toMatchObject({
      source: 'repo',
      path: join(repo, '.claude', 'sessionstat.md'),
      template: 'NEW',
    })
  })
})

describe('a broken template', () => {
  it('falls back to the default and logs why', async () => {
    await writeFile(join(repo, '.sessionstat.md'), '{{#sessions}} never closed')
    const result = await render(await viewFor('claude-code-synthetic.jsonl'), repo)
    expect(result.source).toBe('default')
    expect(result.fallbackError).toMatch(/Unclosed section/)
    expect(result.body).toContain('### Claude Code · 1 session')
    const log = await readFile(paths.logFile(), 'utf-8')
    expect(log).toContain('failed to render, using the default')
  })
})

describe('the marker', () => {
  it('is present when the template leaves it out', async () => {
    await writeFile(join(repo, '.sessionstat.md'), 'just {{totals.turns}} prompts')
    const { body } = await render(await viewFor('claude-code-synthetic.jsonl'), repo)
    expect(body.startsWith(`${MARKER}\n`)).toBe(true)
  })

  it('appears exactly once when the template includes it too', async () => {
    await writeFile(join(repo, '.sessionstat.md'), `${MARKER}\nhello ${MARKER}`)
    const { body } = await render(await viewFor('claude-code-synthetic.jsonl'), repo)
    expect(body.split(MARKER)).toHaveLength(2)
  })

  it('the data block survives a template that tries to fake or drop it', async () => {
    await writeFile(join(repo, '.sessionstat.md'), 'nothing here')
    const { body } = await render(await viewFor('claude-code-synthetic.jsonl'), repo)
    expect(body.trimEnd().endsWith(' -->')).toBe(true)
    expect(body).toContain('<!-- sessionstat:data {"v":1')
  })

  it('is present for an empty template', async () => {
    await writeFile(join(repo, '.sessionstat.md'), '')
    const { body } = await render(await viewFor('claude-code-synthetic.jsonl'), repo)
    expect(body).toContain(MARKER)
  })
})

describe('formatting', () => {
  it('formats numbers so templates never do maths', () => {
    expect(formatDuration(72 * 60_000)).toBe('1h 12m')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatTokens(1_234_567)).toBe('1.2M')
    expect(formatTokens(812)).toBe('812')
    expect(formatTokens(34_500)).toBe('34.5k')
  })
})

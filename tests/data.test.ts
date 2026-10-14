import { describe, expect, it } from 'vitest'
import { MARKER } from '../src/gh.js'
import { prStateFromComments } from '../src/pr-state.js'
import {
  type DataSession,
  buildData,
  computeTotals,
  mergeSessions,
  parseDataBlock,
  serializeDataBlock,
  unionSessions,
} from '../src/template/data.js'

function session(id: string, over: Partial<DataSession> = {}): DataSession {
  return {
    id,
    branch: 'feature/x',
    author: 'alice',
    model: 'claude-opus-5-5',
    startedAt: '2026-10-01T09:00:00.000Z',
    endedAt: '2026-10-01T10:00:00.000Z',
    durationMs: 3_600_000,
    openedBeforePr: false,
    commits: [],
    turns: 3,
    toolCalls: 10,
    toolResults: 10,
    tools: [{ name: 'Bash', count: 10 }],
    files: ['src/a.ts'],
    filesEdited: 1,
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    costUsd: 1.5,
    errors: 1,
    interruptions: 0,
    compactions: 0,
    testRuns: { passed: 1, failed: 0 },
    successRate: 90,
    processQuality: 50,
    iterations: 2,
    linesAdded: 10,
    linesRemoved: 1,
    ...over,
  }
}

describe('the data block', () => {
  it('round-trips', () => {
    const data = buildData([session('s1'), session('s2', { costUsd: null })], 'feature/x')
    const block = serializeDataBlock(data)
    expect(block.startsWith('<!-- sessionstat:data {"v":1,')).toBe(true)
    expect(parseDataBlock(`${MARKER}\n# hi\n\n${block}\n`)).toEqual(data)
  })

  it('escapes -- so the JSON cannot close the HTML comment', () => {
    const data = buildData(
      [session('a--b', { branch: 'fix--it-->now', model: 'x---y', files: ['--> <!-- '] })],
      'fix--it-->now'
    )
    const block = serializeDataBlock(data)
    const inner = block.slice('<!-- '.length, -' -->'.length)
    expect(inner).not.toContain('--')
    // Exactly one comment terminator, at the very end.
    expect(block.indexOf('-->')).toBe(block.length - 3)
    const parsed = parseDataBlock(`text before ${block} text after`)
    expect(parsed).toEqual(data)
    expect(parsed?.sessions[0].branch).toBe('fix--it-->now')
    expect(parsed?.sessions[0].files).toEqual(['--> <!-- '])
  })

  it('reads nothing from a body without a block, or with a broken one', () => {
    expect(parseDataBlock(`${MARKER}\nno data`)).toBeNull()
    expect(parseDataBlock('<!-- sessionstat:data {"v":1, -->')).toBeNull()
    expect(parseDataBlock('<!-- sessionstat:data {"v":2,"sessions":[]} -->')).toBeNull()
  })

  it('totals raw numbers, with cost only over priced sessions', () => {
    const totals = computeTotals([
      session('s1', { files: ['a', 'b'], commits: ['c1'] }),
      session('s2', { costUsd: null, files: ['b'], commits: ['c1', 'c2'] }),
    ])
    expect(totals).toMatchObject({
      sessions: 2,
      turns: 6,
      filesEdited: 2,
      commits: 2,
      costUsd: 1.5,
      costPartial: true,
      successRate: 90,
    })
  })
})

describe('merging local sessions into the persisted state', () => {
  it('keeps sessions only the block has, and local wins for the rest', () => {
    const remote = [
      session('from-other-machine', { startedAt: '2026-10-01T08:00:00.000Z', turns: 9 }),
      session('shared', { turns: 1 }),
    ]
    const local = [
      session('shared', { turns: 5 }),
      session('new', { startedAt: '2026-10-02T00:00:00.000Z' }),
    ]
    const merged = mergeSessions(local, remote)
    expect(merged.map(s => [s.id, s.turns])).toEqual([
      ['from-other-machine', 9],
      ['shared', 5],
      ['new', 3],
    ])
  })

  it('an empty local set never empties the comment', () => {
    expect(mergeSessions([], [session('kept')]).map(s => s.id)).toEqual(['kept'])
  })
})

describe('readPrState: the union across every author', () => {
  const comment = (id: number, login: string, sessions: DataSession[], extra = '') => ({
    id,
    user: { login },
    body: `${MARKER}\n### stats\n${extra}\n${serializeDataBlock(buildData(sessions, 'feature/x'))}\n`,
  })

  it('unions every sessionstat comment by session id, whoever wrote it', () => {
    const output = JSON.stringify([
      { id: 1, user: { login: 'carol' }, body: 'LGTM' },
      comment(2, 'alice', [session('a1'), session('dup', { endedAt: '2026-10-01T10:00:00.000Z' })]),
      comment(3, 'bob', [
        session('b1', { author: 'bob' }),
        session('dup', { endedAt: '2026-10-01T11:00:00.000Z', turns: 42 }),
      ]),
      { id: 4, user: { login: 'dave' }, body: `${MARKER}\nan old comment with no data block` },
    ])
    const state = prStateFromComments(output)
    expect(state.authors).toEqual(['alice', 'bob'])
    expect(state.sessions.map(s => s.id).sort()).toEqual(['a1', 'b1', 'dup'])
    // The copy that ran longest wins.
    expect(state.sessions.find(s => s.id === 'dup')?.turns).toBe(42)
  })

  it('handles paginated output', () => {
    const page1 = JSON.stringify([comment(2, 'alice', [session('a1')])])
    const page2 = JSON.stringify([comment(3, 'bob', [session('b1')])])
    expect(prStateFromComments(`${page1}${page2}`).sessions).toHaveLength(2)
  })

  it('unionSessions alone', () => {
    expect(unionSessions([[session('x')], [session('y')], []]).map(s => s.id)).toEqual(['x', 'y'])
  })
})

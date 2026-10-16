import { describe, expect, it } from 'vitest'
import { MARKER, findOurComment, findPr, interpretPrView } from '../src/gh.js'
import { fakeRunner } from './helpers.js'

describe('finding our comment in gh api output', () => {
  const me = { login: 'alice' }
  const page1 = [
    { id: 1, body: 'LGTM', user: me },
    { id: 2, body: `${MARKER}\n### stats`, user: me },
  ]
  const page2 = [{ id: 3, body: `${MARKER}\nan older duplicate`, user: me }]

  it('reads one page', () => {
    expect(findOurComment(JSON.stringify(page1), 'alice')).toEqual({
      id: 2,
      body: `${MARKER}\n### stats`,
      user: me,
    })
  })
  it('reads --slurp output (an array of pages)', () => {
    expect(findOurComment(JSON.stringify([[{ id: 9, body: 'x' }], page2]), 'alice')?.id).toBe(3)
  })
  it('reads --paginate output (pages concatenated)', () => {
    const out = `${JSON.stringify([{ id: 1, body: 'x' }])}\n${JSON.stringify(page2)}`
    expect(findOurComment(out, 'alice')?.id).toBe(3)
  })
  it('prefers the first when there are several', () => {
    expect(findOurComment(JSON.stringify([...page1, ...page2]), 'alice')?.id).toBe(2)
  })
  it('returns null when there is none, or nothing parseable', () => {
    expect(findOurComment(JSON.stringify([{ id: 1, body: 'hi', user: me }]), 'alice')).toBeNull()
    expect(findOurComment('[]', 'alice')).toBeNull()
    expect(findOurComment('', 'alice')).toBeNull()
    expect(findOurComment('not json', 'alice')).toBeNull()
  })
  it('ignores a marked comment written by someone else', () => {
    const output = JSON.stringify([
      { id: 7, body: `${MARKER}\nbob's stats`, user: { login: 'bob' } },
      { id: 8, body: `${MARKER}\nmine`, user: { login: 'Alice' } },
    ])
    expect(findOurComment(output, 'alice')?.id).toBe(8)
    expect(findOurComment(output, 'carol')).toBeNull()
  })
})

describe('gh pr view', () => {
  const res = (code: number, stdout: string, stderr = '') => ({ code, stdout, stderr })
  it('finds an open PR', () => {
    const out = JSON.stringify({ number: 5, url: 'u', headRefName: 'b', state: 'OPEN' })
    expect(interpretPrView(res(0, out))).toEqual({
      status: 'found',
      pr: { number: 5, url: 'u', headRefName: 'b', state: 'OPEN' },
    })
  })
  it('ignores a merged PR', () => {
    const out = JSON.stringify({ number: 5, url: 'u', headRefName: 'b', state: 'MERGED' })
    expect(interpretPrView(res(0, out)).status).toBe('none')
  })
  it('tells "no PR" from "not logged in" from "not installed" from a timeout', () => {
    expect(interpretPrView(res(1, '', 'no pull requests found for branch "x"')).status).toBe('none')
    expect(interpretPrView(res(4, '', 'please run:  gh auth login')).status).toBe(
      'not-authenticated'
    )
    expect(interpretPrView({ ...res(-1, ''), notFound: true }).status).toBe('not-installed')
    expect(interpretPrView({ ...res(-1, ''), timedOut: true }).status).toBe('timeout')
    expect(interpretPrView(res(1, '', 'HTTP 502')).status).toBe('error')
  })
  it('keeps the branch behind -- so gh cannot read it as a flag', async () => {
    const run = fakeRunner({
      gh: () => ({ code: 1, stdout: '', stderr: 'no pull requests found' }),
    })
    await findPr(run, '/repo', { branch: 'feature/x' })
    expect(run.calls[0].args).toEqual([
      'pr',
      'view',
      '--json',
      'id,number,url,headRefName,state,createdAt',
      '--',
      'feature/x',
    ])
  })
  it('refuses a branch that starts with a dash, without running gh', async () => {
    const run = fakeRunner({ gh: () => ({ code: 0, stdout: '{}', stderr: '' }) })
    expect((await findPr(run, '/repo', { branch: '-Rattacker/evil' })).status).toBe('error')
    expect(run.calls).toEqual([])
  })
})

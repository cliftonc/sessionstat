import type { RunOptions, RunResult } from '../src/runner.js'
import { failed, ok } from './helpers.js'

/** A tiny in-memory GitHub: one PR (or none) and its issue comments. */
export function fakeGitHub(initial: { pr?: { number: number; branch: string } | null } = {}) {
  const state = {
    pr: initial.pr === undefined ? { number: 7, branch: 'feature/login' } : initial.pr,
    comments: [] as Array<{ id: number; body: string; user: { login: string } }>,
    login: 'alice',
    prCreatedAt: '2026-10-01T09:30:00Z',
    nextId: 1000,
    writes: [] as string[],
    authenticated: true,
  }
  const gh = (args: string[], options?: RunOptions): RunResult => {
    if (!state.authenticated) {
      return failed('To get started with GitHub CLI, please run:  gh auth login', 4)
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      if (!state.pr) return failed('no pull requests found for branch "feature/login"')
      return ok(
        JSON.stringify({
          number: state.pr.number,
          url: `https://github.com/acme/app/pull/${state.pr.number}`,
          headRefName: state.pr.branch,
          state: 'OPEN',
          createdAt: state.prCreatedAt,
        })
      )
    }
    if (args[0] === 'api' && args[1] === 'user') return ok(`${state.login}\n`)
    if (args[0] === 'api') {
      const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET'
      const endpoint = args.find(a => a.startsWith('repos/')) ?? ''
      if (method === 'GET') return ok(JSON.stringify(state.comments))
      const body = JSON.parse(options?.input ?? '{}').body as string
      if (method === 'POST') {
        const comment = { id: state.nextId++, body, user: { login: state.login } }
        state.comments.push(comment)
        state.writes.push(`POST ${endpoint}`)
        return ok(JSON.stringify(comment))
      }
      if (method === 'PATCH') {
        const id = Number(endpoint.split('/').pop())
        const comment = state.comments.find(c => c.id === id)
        if (!comment) return failed('Not Found (HTTP 404)')
        if (comment.user.login !== state.login) return failed('Forbidden (HTTP 403)')
        comment.body = body
        state.writes.push(`PATCH ${endpoint}`)
        return ok(JSON.stringify(comment))
      }
    }
    return failed(`unexpected gh ${args.join(' ')}`)
  }
  return { state, gh }
}

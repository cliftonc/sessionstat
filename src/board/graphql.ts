import type { CommandRunner } from '../runner.js'

const GH_TIMEOUT = 30_000

export type GraphqlResult<T> =
  | { ok: true; data: T }
  | {
      ok: false
      message: string
      /** GitHub's error types (`NOT_FOUND`, `INSUFFICIENT_SCOPES`, …), when it gave any. */
      types: string[]
    }

/**
 * One GraphQL request through `gh api graphql`, so it runs as the user's own `gh` login like
 * everything else. The body goes on stdin, which keeps variables typed (numbers stay numbers).
 * Never throws.
 */
export async function graphql<T>(
  run: CommandRunner,
  cwd: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<GraphqlResult<T>> {
  const result = await run('gh', ['api', 'graphql', '--input', '-'], {
    cwd,
    timeoutMs: GH_TIMEOUT,
    input: JSON.stringify({ query, variables }),
  })
  let body: { data?: T; errors?: Array<{ type?: string; message?: string }> } | null = null
  try {
    body = JSON.parse(result.stdout)
  } catch {
    // gh printed nothing useful; fall back to stderr below.
  }
  const errors = body?.errors ?? []
  if (result.code === 0 && body?.data && errors.length === 0) return { ok: true, data: body.data }
  return {
    ok: false,
    message:
      errors.map(e => e.message).find(Boolean) ??
      (result.stderr.trim().replace(/^gh: /, '') || 'gh api graphql failed'),
    types: errors.map(e => e.type).filter((t): t is string => !!t),
  }
}

/** Did the request fail because an id we sent no longer exists (a deleted field or item)? */
export function isStaleId(result: { message: string; types: string[] }): boolean {
  return (
    result.types.includes('NOT_FOUND') ||
    /could not resolve to a node|not found|does not exist/i.test(result.message)
  )
}

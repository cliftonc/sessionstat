import { getGitMetadata } from '../git.js'
import type { CommandRunner } from '../runner.js'
import type { CheckLine } from '../setup.js'
import {
  boardTitle,
  cacheBoard,
  ensureFields,
  fetchProject,
  fetchRepo,
  findOrCreateBoard,
  linkBoard,
} from './board.js'
import { fieldValues, unknownFieldKeys } from './fields.js'
import {
  type BoardSettings,
  loadBoardSettings,
  parseProjectUrl,
  pendingSharedBoard,
  repoSlug,
  sameBoard,
  saveBoardSettings,
} from './settings.js'

export interface BoardSetupDeps {
  run: CommandRunner
  /** Ask a question and return the answer; absent when nobody is there to answer. */
  ask?: (question: string) => Promise<string>
}

export interface BoardSetupOptions {
  /** The repository, any path inside it. */
  repoRoot: string
  /** `create`, a project URL, or absent to ask (if anyone can answer). */
  choice?: string
  /**
   * Save to `<repo>/.claude/sessionstat.json`, to commit so the team shares the board, rather
   * than `~/.sessionstat/config.json`. Absent: ask (default `shareDefault`), or config.json.
   */
  share?: boolean
  /** The answer when asking whether to share. Default no. */
  shareDefault?: boolean
}

export type ScopeCheck = 'ok' | 'missing' | 'unknown'

/**
 * Does the gh token have the `project` scope? Read from `gh auth status`. Fine-grained tokens
 * and `GITHUB_TOKEN` list no scopes, so they come back `unknown` and are tried anyway.
 */
export async function checkProjectScope(run: CommandRunner): Promise<ScopeCheck> {
  const status = await run('gh', ['auth', 'status'], { timeoutMs: 15000 })
  const line = `${status.stdout}\n${status.stderr}`.match(/Token scopes:(.*)/)?.[1]
  if (line === undefined) return 'unknown'
  return /'project'/.test(line) ? 'ok' : 'missing'
}

export const SCOPE_FIX = 'gh auth refresh -s project'

const yes = (answer: string) => /^y(es)?$/i.test(answer.trim())

/**
 * Set up (or check) the Projects v2 board for one repository: pick or create the project,
 * create the fields, link it to the repository and save the setting. With no `choice` and an
 * existing setting, it only checks it; with neither, it asks - or, with nobody to ask, does
 * nothing.
 */
export async function setupBoard(
  options: BoardSetupOptions,
  deps: BoardSetupDeps
): Promise<{ ok: boolean; checks: CheckLine[] }> {
  const checks: CheckLine[] = []
  const done = () => ({ ok: checks.every(c => c.ok), checks })
  const meta = await getGitMetadata(options.repoRoot, deps.run)
  const slug = repoSlug(meta.remoteUrl)
  const repoRoot = meta.toplevel ?? options.repoRoot

  if (!slug) {
    if (options.choice) {
      checks.push({
        ok: false,
        label: 'Project board not set up: this repository has no GitHub remote',
      })
    }
    return done()
  }

  const existing = await loadBoardSettings(repoRoot, slug)
  const pending = await pendingSharedBoard(repoRoot, slug)
  let choice = options.choice
  if (!choice && pending) {
    // The repository's file came with the branch, so anyone who can push one could have
    // written it: nothing is written to the board it names until the user says so.
    const { board } = pending
    const url = board.url ?? `https://github.com/orgs/${board.owner}/projects/${board.number}`
    const prefix = board.prefix !== undefined ? `, fields named "${board.prefix}…"` : ''
    const accepted =
      deps.ask &&
      yes(
        await deps.ask(
          `${pending.source.slice(repoRoot.length + 1)} names the project board ${url}${prefix}. Write ${slug}'s PR stats to it with your gh login? [y/N] `
        )
      )
    if (accepted) {
      await saveBoardSettings({ slug }, board)
      return verifyBoard(slug, repoRoot, board, pending.source, deps, checks)
    }
    checks.push({
      ok: true,
      warn: true,
      label: `Project board in ${pending.source.slice(repoRoot.length + 1)} not used: ${url}`,
      detail: 'It came with the repository; sessionstat writes to it once you accept it',
      fix: `sessionstat board setup ${url}`,
    })
    if (!existing) return done()
  }
  if (!choice && existing) {
    return verifyBoard(slug, repoRoot, existing.board, existing.source, deps, checks)
  }

  if (!choice) {
    if (!deps.ask) return done()
    const want = await deps.ask(
      `Also keep these stats as fields on a GitHub Projects board for ${slug}, to chart them across PRs? [y/N] `
    )
    if (!yes(want)) {
      checks.push({
        ok: true,
        label: 'Project board: not set up',
        detail: 'sessionstat board setup adds one later',
      })
      return done()
    }
    const answer = await deps.ask(
      `Create a new board "${boardTitle(slug)}", or paste the URL of an existing project [create]: `
    )
    choice = answer.trim() || 'create'
  }

  const scope = await checkProjectScope(deps.run)
  if (scope === 'missing') {
    checks.push({
      ok: false,
      label: 'gh token is missing the project scope, needed for a project board',
      fix: SCOPE_FIX,
    })
    return done()
  }

  let target: { owner: string; number: number }
  if (choice === 'create') {
    const board = await findOrCreateBoard(deps.run, repoRoot, slug)
    if (!board.ok) {
      checks.push({ ok: false, label: 'Could not create the project board', detail: board.message })
      return done()
    }
    target = board
    checks.push({
      ok: true,
      label: board.created
        ? `Created project board ${board.url}`
        : `Found project board ${board.url}`,
    })
  } else {
    const parsed = parseProjectUrl(choice)
    if (!parsed) {
      checks.push({
        ok: false,
        label: `Not a project URL: ${choice}`,
        detail:
          'Expected https://github.com/orgs/<org>/projects/<n> or …/users/<user>/projects/<n>',
      })
      return done()
    }
    target = parsed
  }

  // Picking the board the repository shares accepts it, prefix and all.
  const shared = pending ?? (existing?.source.startsWith(repoRoot) ? existing : null)
  const sharedTarget =
    shared && sameBoard(shared.board, { ...target, prefix: shared.board.prefix }) ? shared : null
  const board: BoardSettings = {
    ...(sharedTarget?.board ?? existing?.board ?? {}),
    owner: target.owner,
    number: target.number,
  }
  const fetched = await prepareBoard(slug, board, deps, checks, repoRoot)
  if (!fetched) return done()
  board.url = fetched

  let share = options.share
  if (share === undefined && sharedTarget) share = true
  if (share === undefined && deps.ask) {
    const answer = await deps.ask(
      `Share the board setting with everyone in ${slug} (writes .claude/sessionstat.json, to commit)? ${options.shareDefault ? '[Y/n]' : '[y/N]'} `
    )
    share = answer.trim() ? yes(answer) : !!options.shareDefault
  }
  const where = share ? { slug, repoRoot } : { slug }
  const saved = await saveBoardSettings(where, board)
  checks.push({
    ok: true,
    label: `Project board saved in ${saved}`,
    detail: 'Every PR with sessions is added to it after its comment is posted',
  })
  return done()
}

/** Re-check a board that is already set up: it exists, and has its fields. */
async function verifyBoard(
  slug: string,
  repoRoot: string,
  board: BoardSettings,
  source: string,
  deps: BoardSetupDeps,
  checks: CheckLine[]
): Promise<{ ok: boolean; checks: CheckLine[] }> {
  if ((await checkProjectScope(deps.run)) === 'missing') {
    checks.push({
      ok: false,
      label: 'gh token is missing the project scope, so the project board is not updated',
      fix: SCOPE_FIX,
    })
    return { ok: false, checks }
  }
  await prepareBoard(slug, board, deps, checks, repoRoot, source)
  return { ok: checks.every(c => c.ok), checks }
}

/**
 * Fetch the project, create missing fields, link it to the repository and cache the ids.
 * Returns the project URL, or null after recording what went wrong.
 */
async function prepareBoard(
  slug: string,
  board: BoardSettings,
  deps: BoardSetupDeps,
  checks: CheckLine[],
  cwd: string,
  source?: string
): Promise<string | null> {
  const fetched = await fetchProject(deps.run, cwd, board)
  if (!fetched.ok) {
    checks.push({
      ok: false,
      label: `Could not read project ${board.owner}/${board.number}`,
      detail: fetched.message,
      ...(/scope/.test(fetched.message) ? { fix: SCOPE_FIX } : {}),
    })
    return null
  }
  const project = fetched.board
  const unknown = unknownFieldKeys(board.fields)
  if (unknown.length > 0) {
    checks.push({
      ok: true,
      warn: true,
      label: `Unknown board fields ignored: ${unknown.join(', ')}`,
      detail: 'sessionstat board status lists the field keys',
    })
  }
  const wanted = fieldValues([], { prefix: board.prefix, fields: board.fields })
  const ensured = await ensureFields(deps.run, cwd, project, wanted)
  if (ensured.error) {
    checks.push({ ok: false, label: 'Could not create the board fields', detail: ensured.error })
    return null
  }
  for (const conflict of ensured.conflicts) {
    checks.push({
      ok: true,
      warn: true,
      label: `Board field ${conflict} has another type; sessionstat leaves it alone`,
      fix: 'Rename it, or set a different "prefix" for the board',
    })
  }
  checks.push({
    ok: true,
    label: `Project board ${project.url}${source ? ` (${source})` : ''}`,
    detail: ensured.created.length
      ? `Added ${ensured.created.length} fields: ${ensured.created.join(', ')}`
      : `${wanted.length} fields in place`,
  })

  // Linking puts the board on the repository's Projects tab. Only the repository's owner can.
  const repo = await fetchRepo(deps.run, cwd, slug)
  if (repo.ok && repo.owner.toLowerCase() === board.owner.toLowerCase()) {
    const linked = await linkBoard(deps.run, cwd, project.projectId, repo.id)
    if (!linked.ok) {
      checks.push({
        ok: true,
        warn: true,
        label: `Could not link the board to ${slug}`,
        detail: linked.message,
      })
    }
  }
  await cacheBoard(slug, project)
  return project.url
}

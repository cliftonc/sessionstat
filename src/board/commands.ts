import { findPr } from '../gh.js'
import { getGitMetadata } from '../git.js'
import { paths } from '../paths.js'
import { readPrState } from '../pr-state.js'
import type { CommandRunner } from '../runner.js'
import { type BoardOutcome, fetchProject, loadBoardCache, syncBoard } from './board.js'
import { FIELDS, fieldValues } from './fields.js'
import { loadBoardSettings, repoSlug } from './settings.js'
import { SCOPE_FIX, checkProjectScope } from './setup.js'

export interface BoardCommandDeps {
  run: CommandRunner
  out: (line: string) => void
  cwd: string
}

async function currentRepo(deps: BoardCommandDeps) {
  const meta = await getGitMetadata(deps.cwd, deps.run)
  if (!meta.toplevel) throw new Error('Not inside a git repository')
  const slug = repoSlug(meta.remoteUrl)
  if (!slug) throw new Error('This repository has no GitHub remote')
  return { repoRoot: meta.toplevel, slug, branch: meta.branch }
}

/** The project, its fields, the last sync and the token scope. Returns false if not healthy. */
export async function runBoardStatus(deps: BoardCommandDeps): Promise<boolean> {
  const { repoRoot, slug } = await currentRepo(deps)
  const settings = await loadBoardSettings(repoRoot, slug)
  if (!settings) {
    deps.out(`No project board for ${slug}. Add one with: sessionstat board setup`)
    return true
  }
  const { board } = settings
  const scope = await checkProjectScope(deps.run)
  const cached = (await loadBoardCache())[slug]
  deps.out(`Project board for ${slug}`)
  deps.out(`  project   ${board.url ?? `${board.owner} #${board.number}`}`)
  deps.out(`  setting   ${settings.source}`)
  deps.out(
    `  scope     ${scope === 'ok' ? 'project ✓' : scope === 'missing' ? `missing project — ${SCOPE_FIX}` : 'unknown (not a classic token); tried anyway'}`
  )
  deps.out(`  last sync ${cached?.lastSyncAt ?? 'never'}`)
  deps.out(`  PRs       ${cached ? Object.keys(cached.items).length : 0} on the board from here`)
  if (cached?.lastError) deps.out(`  error     ${cached.lastError}`)

  const project = await fetchProject(deps.run, repoRoot, board)
  if (!project.ok) {
    deps.out(`  ✗ ${project.message}`)
    return false
  }
  deps.out('')
  deps.out('Fields (key: name)')
  let healthy = scope !== 'missing'
  for (const field of fieldValues([], { prefix: board.prefix, fields: board.fields })) {
    const found = project.board.fields[field.name]
    const mark = !found ? '✗ missing' : found.type !== field.type ? `✗ is ${found.type}` : '✓'
    if (mark !== '✓') healthy = false
    deps.out(`  ${mark} ${field.key}: ${field.name}`)
  }
  const unused = FIELDS.filter(f => board.fields && !board.fields.includes(f.key))
  if (unused.length > 0) deps.out(`  (left out: ${unused.map(f => f.key).join(', ')})`)
  if (!healthy) deps.out('\nRun `sessionstat board setup` to create missing fields.')
  deps.out(`\n(cache: ${paths.boardCache()})`)
  return healthy
}

/**
 * Rewrite one PR's fields from the comments alone: the union of every sessionstat data block on
 * it. The board holds no state, so this rebuilds it exactly.
 */
export async function runBoardResync(
  deps: BoardCommandDeps,
  options: { pr?: string } = {}
): Promise<BoardOutcome> {
  const { repoRoot, slug } = await currentRepo(deps)
  const settings = await loadBoardSettings(repoRoot, slug)
  if (!settings)
    throw new Error(`No project board for ${slug}. Add one with: sessionstat board setup`)
  const lookup = await findPr(deps.run, repoRoot, options.pr ? { branch: options.pr, anyState: true } : {})
  if (lookup.status !== 'found') throw new Error(`No open PR found (${lookup.status})`)
  const pr = lookup.pr
  if (!pr.id) throw new Error('gh pr view returned no PR id')
  const state = await readPrState(deps.run, repoRoot, pr)
  if (!state.ok) throw new Error(`Could not read the PR's comments: ${state.message}`)
  if (state.state.sessions.length === 0) {
    throw new Error(`#${pr.number} has no sessionstat comments with data yet`)
  }
  return syncBoard(deps.run, repoRoot, {
    slug,
    board: settings.board,
    pr: { id: pr.id, number: pr.number },
    sessions: state.state.sessions,
    force: true,
  })
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { paths } from '../paths.js'
import type { CommandRunner } from '../runner.js'
import type { DataSession } from '../template/data.js'
import { type FieldType, type FieldValue, type ResolvedField, fieldValues } from './fields.js'
import { type GraphqlResult, graphql, isStaleId } from './graphql.js'
import type { BoardSettings } from './settings.js'

/**
 * Mirror a PR's session totals into number, date and single-select fields on a Projects v2
 * board. The comments stay the source of truth; the board is an opt-in copy that holds no
 * state of its own.
 *
 * Every id (project, fields, the PR's item) is cached in `~/.sessionstat/board-cache.json`
 * per repository, with the values last written, so a sync only writes fields that changed. A
 * write that fails on an unknown id drops the cache and tries once more from scratch.
 */

export interface SelectOption {
  id: string
  name: string
  color: string
  description: string
}

interface CachedField {
  id: string
  /** GitHub's `dataType`: ours are NUMBER, DATE and SINGLE_SELECT; anything else is someone else's. */
  type: string
  options?: SelectOption[]
}

export interface CachedBoard {
  owner: string
  number: number
  projectId: string
  url: string
  title: string
  fields: Record<string, CachedField>
  /** By PR number. */
  items: Record<string, { itemId: string; values: Record<string, FieldValue> }>
  lastSyncAt?: string
  lastError?: string
}

type BoardCache = Record<string, CachedBoard>

export async function loadBoardCache(): Promise<BoardCache> {
  try {
    const parsed = JSON.parse(await readFile(paths.boardCache(), 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as BoardCache) : {}
  } catch {
    return {}
  }
}

/** Re-read before writing so two workers on different branches lose as little as possible. */
async function updateBoardCache(slug: string, entry: CachedBoard | null): Promise<void> {
  const cache = await loadBoardCache()
  if (entry) cache[slug] = entry
  else delete cache[slug]
  const file = paths.boardCache()
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 })
  await rename(tmp, file)
}

// ── Reading the project ─────────────────────────────────────────────────────

const FIELDS_SELECTION = `fields(first: 100) { nodes {
  ... on ProjectV2Field { id name dataType }
  ... on ProjectV2SingleSelectField { id name dataType options { id name color description } }
  ... on ProjectV2IterationField { id name dataType }
} }`

const PROJECT_QUERY = `query SessionstatProject($owner: String!, $number: Int!) {
  repositoryOwner(login: $owner) {
    ... on Organization { projectV2(number: $number) { id title url ${FIELDS_SELECTION} } }
    ... on User { projectV2(number: $number) { id title url ${FIELDS_SELECTION} } }
  }
}`

interface ProjectNode {
  id: string
  title: string
  url: string
  fields: {
    nodes: Array<{ id?: string; name?: string; dataType?: string; options?: SelectOption[] }>
  }
}

function toFields(project: ProjectNode): Record<string, CachedField> {
  const fields: Record<string, CachedField> = {}
  for (const node of project.fields.nodes) {
    if (!node.id || !node.name || !node.dataType) continue
    fields[node.name] = {
      id: node.id,
      type: node.dataType,
      ...(node.options ? { options: node.options } : {}),
    }
  }
  return fields
}

export async function fetchProject(
  run: CommandRunner,
  cwd: string,
  board: Pick<BoardSettings, 'owner' | 'number'>
): Promise<{ ok: true; board: CachedBoard } | { ok: false; message: string }> {
  const result = await graphql<{ repositoryOwner: { projectV2?: ProjectNode | null } | null }>(
    run,
    cwd,
    PROJECT_QUERY,
    { owner: board.owner, number: board.number }
  )
  if (!result.ok) return { ok: false, message: scopeHint(result) }
  const project = result.data.repositoryOwner?.projectV2
  if (!project) {
    return { ok: false, message: `No project ${board.number} found for ${board.owner}` }
  }
  return {
    ok: true,
    board: {
      owner: board.owner,
      number: board.number,
      projectId: project.id,
      url: project.url,
      title: project.title,
      fields: toFields(project),
      items: {},
    },
  }
}

/** Say how to fix a missing `project` scope, the most likely reason a board call fails. */
function scopeHint(result: Extract<GraphqlResult<unknown>, { ok: false }>): string {
  if (result.types.includes('INSUFFICIENT_SCOPES') || /scope/i.test(result.message)) {
    return `${result.message} (run: gh auth refresh -s project)`
  }
  return result.message
}

// ── Fields ──────────────────────────────────────────────────────────────────

const CREATE_FIELD = `mutation SessionstatCreateField($input: CreateProjectV2FieldInput!) {
  createProjectV2Field(input: $input) {
    projectV2Field {
      ... on ProjectV2Field { id name dataType }
      ... on ProjectV2SingleSelectField { id name dataType options { id name color description } }
    }
  }
}`

const UPDATE_OPTIONS = `mutation SessionstatAddOption($input: UpdateProjectV2FieldInput!) {
  updateProjectV2Field(input: $input) {
    projectV2Field {
      ... on ProjectV2SingleSelectField { id name dataType options { id name color description } }
    }
  }
}`

interface FieldNode {
  id: string
  name: string
  dataType: string
  options?: SelectOption[]
}

/**
 * Create any of `wanted` the board lacks, matched by name. A field that exists with the wrong
 * type is the user's: it is reported and left alone, never renamed or changed.
 */
export async function ensureFields(
  run: CommandRunner,
  cwd: string,
  board: CachedBoard,
  wanted: Array<{ name: string; type: FieldType; value?: FieldValue }>
): Promise<{ created: string[]; conflicts: string[]; error?: string }> {
  const created: string[] = []
  const conflicts: string[] = []
  for (const field of wanted) {
    const existing = board.fields[field.name]
    if (existing) {
      if (existing.type !== field.type) conflicts.push(`${field.name} (${existing.type})`)
      continue
    }
    const input: Record<string, unknown> = {
      projectId: board.projectId,
      dataType: field.type,
      name: field.name,
    }
    // A single select needs at least one option to be created with.
    if (field.type === 'SINGLE_SELECT') {
      const first = typeof field.value === 'string' ? field.value : 'unknown'
      input.singleSelectOptions = [{ name: first, color: 'GRAY', description: '' }]
    }
    const result = await graphql<{ createProjectV2Field: { projectV2Field: FieldNode } }>(
      run,
      cwd,
      CREATE_FIELD,
      { input }
    )
    if (!result.ok) return { created, conflicts, error: `${field.name}: ${scopeHint(result)}` }
    const node = result.data.createProjectV2Field.projectV2Field
    board.fields[field.name] = {
      id: node.id,
      type: node.dataType,
      ...(node.options ? { options: node.options } : {}),
    }
    created.push(field.name)
  }
  return { created, conflicts }
}

/** The option id for `name`, adding the option to the field (keeping every other) if it is new. */
async function ensureOption(
  run: CommandRunner,
  cwd: string,
  field: CachedField,
  name: string
): Promise<GraphqlResult<string>> {
  const found = field.options?.find(o => o.name === name)
  if (found) return { ok: true, data: found.id }
  const options = [
    ...(field.options ?? []).map(o => ({
      id: o.id,
      name: o.name,
      color: o.color,
      description: o.description,
    })),
    { name, color: 'GRAY', description: '' },
  ]
  const result = await graphql<{ updateProjectV2Field: { projectV2Field: FieldNode } }>(
    run,
    cwd,
    UPDATE_OPTIONS,
    { input: { fieldId: field.id, singleSelectOptions: options } }
  )
  if (!result.ok) return result
  field.options = result.data.updateProjectV2Field.projectV2Field.options ?? []
  const added = field.options.find(o => o.name === name)
  return added
    ? { ok: true, data: added.id }
    : { ok: false, message: `option ${name} was not added`, types: [] }
}

// ── Items and values ────────────────────────────────────────────────────────

const ADD_ITEM = `mutation SessionstatAddItem($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
}`

function setValuesMutation(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$f${i}: ID!, $v${i}: ProjectV2FieldValue!`)
  const sets = Array.from(
    { length: count },
    (_, i) =>
      `  s${i}: updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $f${i}, value: $v${i} }) { clientMutationId }`
  )
  return `mutation SessionstatSetValues($projectId: ID!, $itemId: ID!, ${vars.join(', ')}) {\n${sets.join('\n')}\n}`
}

function fieldValueInput(type: string, value: FieldValue, optionId?: string) {
  if (type === 'NUMBER') return { number: value }
  if (type === 'DATE') return { date: value }
  return { singleSelectOptionId: optionId }
}

export type BoardOutcome =
  | { status: 'updated'; url: string; written: string[]; created: string[] }
  | { status: 'unchanged'; url: string }
  | { status: 'error'; message: string }

export interface SyncInput {
  /** `owner/repo`, the cache key. */
  slug: string
  board: BoardSettings
  /** The PR's node id (`gh pr view --json id`) and number. */
  pr: { id: string; number: number }
  /** Every session on the PR, from every author. */
  sessions: DataSession[]
  /** Write every field, even those the cache says are already set (a resync). */
  force?: boolean
  now?: Date
}

/**
 * Put the PR on the board and write its fields. Never throws: a board that cannot be written
 * is logged by the caller, and posting the comment is never affected.
 */
export async function syncBoard(
  run: CommandRunner,
  cwd: string,
  input: SyncInput
): Promise<BoardOutcome> {
  const first = await syncOnce(run, cwd, input, false)
  if (first.status === 'error' && first.stale)
    return stripStale(await syncOnce(run, cwd, input, true))
  return stripStale(first)
}

function stripStale(outcome: BoardOutcome & { stale?: boolean }): BoardOutcome {
  const { stale: _, ...rest } = outcome
  return rest as BoardOutcome
}

async function syncOnce(
  run: CommandRunner,
  cwd: string,
  input: SyncInput,
  fresh: boolean
): Promise<BoardOutcome & { stale?: boolean }> {
  const now = (input.now ?? new Date()).toISOString()
  const cache = fresh ? {} : await loadBoardCache()
  let board = cache[input.slug]
  if (!board || board.owner !== input.board.owner || board.number !== input.board.number) {
    const fetched = await fetchProject(run, cwd, input.board)
    if (!fetched.ok) return { status: 'error', message: fetched.message }
    board = fetched.board
  }
  const fail = async (message: string, stale = false) => {
    await updateBoardCache(input.slug, { ...board, lastError: `${now} ${message}` })
    return { status: 'error' as const, message, stale }
  }

  const fields = fieldValues(input.sessions, {
    prefix: input.board.prefix,
    fields: input.board.fields,
  })
  const ensured = await ensureFields(run, cwd, board, fields)
  if (ensured.error) return fail(ensured.error)
  const usable = fields.filter(
    (f): f is ResolvedField & { value: number | string } =>
      f.value !== null && board.fields[f.name]?.type === f.type
  )

  const key = String(input.pr.number)
  let item = board.items[key]
  if (!item) {
    const added = await graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
      run,
      cwd,
      ADD_ITEM,
      { projectId: board.projectId, contentId: input.pr.id }
    )
    if (!added.ok) return fail(`adding PR #${key}: ${scopeHint(added)}`, isStaleId(added))
    item = { itemId: added.data.addProjectV2ItemById.item.id, values: {} }
    board.items[key] = item
  }

  const changed = usable.filter(f => input.force || item.values[f.name] !== f.value)
  if (changed.length === 0) {
    await updateBoardCache(input.slug, { ...board, lastSyncAt: now, lastError: undefined })
    return { status: 'unchanged', url: board.url }
  }

  const variables: Record<string, unknown> = { projectId: board.projectId, itemId: item.itemId }
  for (const [i, f] of changed.entries()) {
    const field = board.fields[f.name]
    let optionId: string | undefined
    if (f.type === 'SINGLE_SELECT') {
      const option = await ensureOption(run, cwd, field, String(f.value))
      if (!option.ok) return fail(`${f.name}: ${option.message}`, isStaleId(option))
      optionId = option.data
    }
    variables[`f${i}`] = field.id
    variables[`v${i}`] = fieldValueInput(f.type, f.value, optionId)
  }
  const written = await graphql(run, cwd, setValuesMutation(changed.length), variables)
  if (!written.ok) return fail(`writing fields: ${scopeHint(written)}`, isStaleId(written))

  for (const f of changed) item.values[f.name] = f.value
  await updateBoardCache(input.slug, { ...board, lastSyncAt: now, lastError: undefined })
  return {
    status: 'updated',
    url: board.url,
    written: changed.map(f => f.name),
    created: ensured.created,
  }
}

// ── Creating and linking a board ────────────────────────────────────────────

const REPO_QUERY = `query SessionstatRepo($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id owner { id login } }
}`

const FIND_PROJECT = `query SessionstatFindProject($owner: String!, $title: String!) {
  repositoryOwner(login: $owner) {
    ... on Organization { projectsV2(first: 20, query: $title) { nodes { number title url closed } } }
    ... on User { projectsV2(first: 20, query: $title) { nodes { number title url closed } } }
  }
}`

const CREATE_PROJECT = `mutation SessionstatCreateProject($ownerId: ID!, $title: String!, $repositoryId: ID!) {
  createProjectV2(input: { ownerId: $ownerId, title: $title, repositoryId: $repositoryId }) {
    projectV2 { number url }
  }
}`

const LINK_REPO = `mutation SessionstatLinkRepo($projectId: ID!, $repositoryId: ID!) {
  linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) { clientMutationId }
}`

export function boardTitle(slug: string): string {
  return `sessionstat: ${slug}`
}

export async function fetchRepo(
  run: CommandRunner,
  cwd: string,
  slug: string
): Promise<
  { ok: true; id: string; owner: string; ownerId: string } | { ok: false; message: string }
> {
  const [owner, name] = slug.split('/')
  const result = await graphql<{
    repository: { id: string; owner: { id: string; login: string } } | null
  }>(run, cwd, REPO_QUERY, { owner, name })
  if (!result.ok) return { ok: false, message: scopeHint(result) }
  if (!result.data.repository) return { ok: false, message: `Repository ${slug} not found` }
  const repo = result.data.repository
  return { ok: true, id: repo.id, owner: repo.owner.login, ownerId: repo.owner.id }
}

/**
 * The board for this repository: an open project already called `sessionstat: owner/repo` if
 * there is one (so running setup twice never makes two), otherwise a new one, owned by the
 * repository's owner and linked to the repository so it shows on its Projects tab.
 */
export async function findOrCreateBoard(
  run: CommandRunner,
  cwd: string,
  slug: string
): Promise<
  | { ok: true; owner: string; number: number; url: string; created: boolean }
  | { ok: false; message: string }
> {
  const repo = await fetchRepo(run, cwd, slug)
  if (!repo.ok) return repo
  const title = boardTitle(slug)
  const found = await graphql<{
    repositoryOwner: {
      projectsV2?: { nodes: Array<{ number: number; title: string; url: string; closed: boolean }> }
    } | null
  }>(run, cwd, FIND_PROJECT, { owner: repo.owner, title })
  if (!found.ok) return { ok: false, message: scopeHint(found) }
  const existing = found.data.repositoryOwner?.projectsV2?.nodes.find(
    p => p.title === title && !p.closed
  )
  if (existing) {
    return {
      ok: true,
      owner: repo.owner,
      number: existing.number,
      url: existing.url,
      created: false,
    }
  }

  const created = await graphql<{
    createProjectV2: { projectV2: { number: number; url: string } }
  }>(run, cwd, CREATE_PROJECT, { ownerId: repo.ownerId, title, repositoryId: repo.id })
  if (!created.ok) return { ok: false, message: scopeHint(created) }
  const project = created.data.createProjectV2.projectV2
  return { ok: true, owner: repo.owner, number: project.number, url: project.url, created: true }
}

/** Link the project to the repository (idempotent). Only possible when they share an owner. */
export async function linkBoard(
  run: CommandRunner,
  cwd: string,
  projectId: string,
  repositoryId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await graphql(run, cwd, LINK_REPO, { projectId, repositoryId })
  return result.ok ? { ok: true } : { ok: false, message: result.message }
}

/** Remember a freshly fetched project, keeping the items already known for it. */
export async function cacheBoard(slug: string, board: CachedBoard): Promise<void> {
  const existing = (await loadBoardCache())[slug]
  const sameProject = existing?.projectId === board.projectId
  await updateBoardCache(slug, {
    ...board,
    items: sameProject ? existing.items : board.items,
    ...(sameProject && existing.lastSyncAt ? { lastSyncAt: existing.lastSyncAt } : {}),
  })
}

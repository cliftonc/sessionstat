import type { RunResult } from '../src/runner.js'
import { ok } from './helpers.js'

/**
 * A tiny in-memory Projects v2 API, answering `gh api graphql --input -` by operation name.
 * Records every operation so tests can count what a sync did.
 */
export function fakeProjects() {
  interface Field {
    id: string
    name: string
    dataType: string
    options?: Array<{ id: string; name: string; color: string; description: string }>
  }
  type OptionInput = { id?: string; name: string; color: string; description: string }
  interface Project {
    id: string
    owner: string
    number: number
    title: string
    url: string
    closed: boolean
    fields: Field[]
    items: Map<string, { contentId: string; values: Record<string, unknown> }>
    linked: string[]
  }
  const state = {
    projects: [] as Project[],
    repo: { id: 'R_app', owner: 'acme', ownerId: 'O_acme', name: 'app' },
    operations: [] as string[],
    /** Fail every write with this error (e.g. a missing scope). */
    failWrites: null as null | { type: string; message: string },
    nextId: 1,
  }
  const id = (prefix: string) => `${prefix}_${state.nextId++}`

  const addProject = (owner: string, number: number, title = 'Existing') => {
    const project: Project = {
      id: id('PVT'),
      owner,
      number,
      title,
      url: `https://github.com/orgs/${owner}/projects/${number}`,
      closed: false,
      fields: [{ id: id('F'), name: 'Status', dataType: 'SINGLE_SELECT', options: [] }],
      items: new Map(),
      linked: [],
    }
    state.projects.push(project)
    return project
  }

  const error = (type: string, message: string): RunResult => ({
    code: 1,
    stdout: JSON.stringify({ data: null, errors: [{ type, message }] }),
    stderr: `gh: ${message}`,
  })
  const data = (d: unknown): RunResult => ok(JSON.stringify({ data: d }))
  const byId = (pid: string) => state.projects.find(p => p.id === pid)
  const fieldNode = (f: Field) => ({ ...f })

  const graphql = (input: string): RunResult => {
    const { query, variables: v } = JSON.parse(input) as {
      query: string
      // biome-ignore lint/suspicious/noExplicitAny: GraphQL variables of every shape
      variables: Record<string, any>
    }
    const op = query.match(/(?:query|mutation) (\w+)/)?.[1] ?? 'anonymous'
    state.operations.push(op)
    if (query.startsWith('mutation') && state.failWrites) {
      return error(state.failWrites.type, state.failWrites.message)
    }
    switch (op) {
      case 'SessionstatProject': {
        const p = state.projects.find(x => x.owner === v.owner && x.number === v.number)
        return data({
          repositoryOwner: {
            projectV2: p
              ? { id: p.id, title: p.title, url: p.url, fields: { nodes: p.fields.map(fieldNode) } }
              : null,
          },
        })
      }
      case 'SessionstatRepo':
        return data({
          repository: {
            id: state.repo.id,
            owner: { id: state.repo.ownerId, login: state.repo.owner },
          },
        })
      case 'SessionstatFindProject':
        return data({
          repositoryOwner: {
            projectsV2: {
              nodes: state.projects
                .filter(p => p.owner === v.owner && p.title.includes(v.title))
                .map(p => ({ number: p.number, title: p.title, url: p.url, closed: p.closed })),
            },
          },
        })
      case 'SessionstatCreateProject': {
        const p = addProject(state.repo.owner, state.projects.length + 1, v.title)
        p.linked.push(v.repositoryId)
        return data({ createProjectV2: { projectV2: { number: p.number, url: p.url } } })
      }
      case 'SessionstatLinkRepo': {
        const p = byId(v.projectId)
        if (p && !p.linked.includes(v.repositoryId)) p.linked.push(v.repositoryId)
        return data({ linkProjectV2ToRepository: { clientMutationId: null } })
      }
      case 'SessionstatCreateField': {
        const p = byId(v.input.projectId)
        if (!p) return error('NOT_FOUND', 'Could not resolve to a node')
        const f: Field = { id: id('F'), name: v.input.name, dataType: v.input.dataType }
        if (v.input.singleSelectOptions) {
          f.options = v.input.singleSelectOptions.map((o: OptionInput) => ({ ...o, id: id('O') }))
        }
        p.fields.push(f)
        return data({ createProjectV2Field: { projectV2Field: fieldNode(f) } })
      }
      case 'SessionstatAddOption': {
        const f = state.projects.flatMap(p => p.fields).find(x => x.id === v.input.fieldId)
        if (!f) return error('NOT_FOUND', 'Could not resolve to a node')
        f.options = v.input.singleSelectOptions.map((o: OptionInput) => ({
          ...o,
          id: o.id ?? id('O'),
        }))
        return data({ updateProjectV2Field: { projectV2Field: fieldNode(f) } })
      }
      case 'SessionstatAddItem': {
        const p = byId(v.projectId)
        if (!p) return error('NOT_FOUND', 'Could not resolve to a node')
        for (const [itemId, item] of p.items) {
          if (item.contentId === v.contentId)
            return data({ addProjectV2ItemById: { item: { id: itemId } } })
        }
        const itemId = id('PVTI')
        p.items.set(itemId, { contentId: v.contentId, values: {} })
        return data({ addProjectV2ItemById: { item: { id: itemId } } })
      }
      case 'SessionstatSetValues': {
        const p = byId(v.projectId)
        const item = p?.items.get(v.itemId)
        if (!p || !item) return error('NOT_FOUND', 'Could not resolve to a node with the global id')
        for (let i = 0; `f${i}` in v; i++) {
          const f = p.fields.find(x => x.id === v[`f${i}`])
          if (!f) return error('NOT_FOUND', 'Could not resolve to a node')
          const value = v[`v${i}`]
          item.values[f.name] =
            'singleSelectOptionId' in value
              ? f.options?.find(o => o.id === value.singleSelectOptionId)?.name
              : (value.number ?? value.date)
        }
        return data({})
      }
    }
    return error('UNKNOWN', `unexpected operation ${op}`)
  }

  /** The values on the board for a PR, by field name. */
  const valuesFor = (project: Project, contentId: string) =>
    [...project.items.values()].find(i => i.contentId === contentId)?.values

  return { state, graphql, addProject, valuesFor }
}

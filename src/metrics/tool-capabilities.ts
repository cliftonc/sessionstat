/**
 * Provider-agnostic tool capability mapping.
 *
 * Process quality is about what the agent DID - did it read before writing, did it verify
 * its work - not about which vendor's tool names appear. Matching literal Claude Code
 * names meant every other provider scored zero by construction: an OpenCode session with
 * 31 `read`, 29 `edit`, 36 `bash` and 22 `todowrite` calls scored 0 for read-before-write,
 * verification AND todo tracking, purely because the names are lowercase.
 *
 * Names are normalised (lowercased, separators removed) before lookup, so `TodoWrite`,
 * `todowrite` and `todo_write` all resolve to the same capability.
 */

export type ToolCapability = 'read' | 'write' | 'execute' | 'plan' | 'todo'

/** Strip case and separators so naming conventions stop mattering. */
export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Exact matches, keyed by normalised name.
 *
 * Sources: Claude Code, OpenCode and Gemini names observed in session fixtures; Codex and
 * Copilot names from their converters.
 */
const EXACT: Record<string, ToolCapability> = {
  // --- read / search ---
  read: 'read',
  readfile: 'read',
  readmanyfiles: 'read',
  grep: 'read',
  glob: 'read',
  list: 'read',
  ls: 'read',
  listdirectory: 'read',
  searchfilecontent: 'read',
  codebasesearch: 'read',
  filesearch: 'read',
  notebookread: 'read',
  // Copilot CLI. `view` reads a file or lists a directory; `rg` is its ripgrep. Neither
  // contains a verb the substring rules know, so both used to classify as nothing.
  view: 'read',
  rg: 'read',

  // --- write / modify ---
  write: 'write',
  writefile: 'write',
  edit: 'write',
  multiedit: 'write',
  notebookedit: 'write',
  applypatch: 'write',
  patch: 'write',
  replace: 'write',
  strreplaceeditor: 'write',
  createfile: 'write',
  insertedit: 'write',

  // --- execute / verify ---
  bash: 'execute',
  bashoutput: 'execute',
  shell: 'execute',
  localshell: 'execute',
  exec: 'execute',
  runshellcommand: 'execute',
  runinterminal: 'execute',
  runcommand: 'execute',
  terminal: 'execute',
  runtests: 'execute',

  // --- planning ---
  exitplanmode: 'plan',
  planmode: 'plan',
  updateplan: 'plan',
  plan: 'plan',

  // --- todo tracking ---
  //
  // The names churn. Measured across 913 local Claude Code sessions: `TodoWrite` was
  // already gone, `TaskCreate`/`TaskUpdate` ran from 2.1.220 to 2.1.227 (491 and 867
  // calls), and 2.1.232 onward emits no task-list tool at all.
  //
  // `taskcreate` MUST be listed here rather than left to the substring rules: it contains
  // "create", so it used to fall through to `['create', 'write']` and be counted as a
  // WRITE, inflating read/write ratio and the incremental-approach band across every
  // session in that era. `taskupdate` matched no rule and was dropped entirely.
  //
  // `taskstop` and `taskoutput` are deliberately absent - they control background
  // subagents (opaque `task_id` like "bluvcpr3d"), not task lists.
  todowrite: 'todo',
  todoread: 'todo',
  todo: 'todo',
  managetodolist: 'todo',
  updatetodos: 'todo',
  taskcreate: 'todo',
  taskupdate: 'todo',
}

/**
 * Substring fallbacks, applied in order when there is no exact match.
 *
 * Deliberately ordered: a name containing both "plan" and "write" should count as
 * planning, and "todo" beats the generic read/write verbs.
 */
/**
 * Names that a substring rule would misclassify, and which mean nothing for process quality.
 *
 * Copilot CLI's background-shell controls contain "bash", so the substring rules counted
 * them as execution - and execution after a write is what earns the verification points.
 * Stopping a shell or listing the running ones verifies nothing. `read_bash` and
 * `write_bash` are deliberately NOT here: polling a running command's output or feeding it
 * input is part of running it, as Claude Code's `BashOutput` is.
 */
const NO_CAPABILITY = new Set(['stopbash', 'listbash'])

const SUBSTRING_RULES: Array<[string, ToolCapability]> = [
  ['exitplan', 'plan'],
  ['todo', 'todo'],
  ['shell', 'execute'],
  ['terminal', 'execute'],
  ['bash', 'execute'],
  ['command', 'execute'],
  ['patch', 'write'],
  ['edit', 'write'],
  ['write', 'write'],
  ['create', 'write'],
  ['search', 'read'],
  ['read', 'read'],
  ['glob', 'read'],
  ['grep', 'read'],
  ['list', 'read'],
]

/**
 * Classify a tool by what it does. Returns `null` for tools with no process-quality
 * meaning (web fetches, screenshots, MCP calls, sub-agents).
 */
export function getToolCapability(name: string): ToolCapability | null {
  if (!name) return null

  const normalized = normalizeToolName(name)
  const exact = EXACT[normalized]
  if (exact) return exact
  if (NO_CAPABILITY.has(normalized)) return null

  for (const [needle, capability] of SUBSTRING_RULES) {
    if (normalized.includes(needle)) return capability
  }

  return null
}

/** Count tools by capability in a single pass. */
export function countByCapability(names: string[]): Record<ToolCapability, number> {
  const counts: Record<ToolCapability, number> = {
    read: 0,
    write: 0,
    execute: 0,
    plan: 0,
    todo: 0,
  }

  for (const name of names) {
    const capability = getToolCapability(name)
    if (capability) counts[capability] += 1
  }

  return counts
}

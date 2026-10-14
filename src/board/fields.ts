import { type DataSession, computeTotals } from '../template/data.js'

/**
 * The fields sessionstat keeps on a Projects v2 board, and their values for one PR.
 *
 * Values are always recomputed from every session on the PR (the union of every author's data
 * block), never incremented, so writing the same PR twice is harmless and a board can be
 * rebuilt from the comments at any time.
 */

export type FieldType = 'NUMBER' | 'DATE' | 'SINGLE_SELECT'

/** A number, a `YYYY-MM-DD` date, or a single-select option name. Null leaves the field alone. */
export type FieldValue = number | string | null

export interface FieldSpec {
  /** Stable key, used in the `boardFields` setting. */
  key: string
  /** Name without the prefix. */
  label: string
  type: FieldType
  value: (sessions: DataSession[]) => FieldValue
}

const DEFAULT_PREFIX = 'Agent '

const round = (n: number, places: number) => {
  const f = 10 ** places
  return Math.round(n * f) / f
}
const minutes = (ms: number) => round(ms / 60_000, 1)
const usd = (n: number | null) => (n === null ? null : round(n, 2))
const build = (s: DataSession[]) => s.filter(x => !x.openedBeforePr)
const followUp = (s: DataSession[]) => s.filter(x => x.openedBeforePr)

/** The model that did most of the work: the one with the most session time. */
export function mainModel(sessions: DataSession[]): string | null {
  const time = new Map<string, number>()
  for (const s of sessions) {
    if (!s.model) continue
    time.set(s.model, (time.get(s.model) ?? 0) + Math.max(s.durationMs, 1))
  }
  let best: string | null = null
  for (const [model, ms] of time) if (best === null || ms > (time.get(best) ?? 0)) best = model
  return best
}

export const FIELDS: FieldSpec[] = [
  { key: 'sessions', label: 'sessions', type: 'NUMBER', value: s => s.length },
  {
    key: 'minutes',
    label: 'active minutes',
    type: 'NUMBER',
    value: s => minutes(computeTotals(s).durationMs),
  },
  { key: 'turns', label: 'turns', type: 'NUMBER', value: s => computeTotals(s).turns },
  { key: 'toolCalls', label: 'tool calls', type: 'NUMBER', value: s => computeTotals(s).toolCalls },
  {
    key: 'tokens',
    label: 'tokens (M)',
    type: 'NUMBER',
    value: s => {
      const t = computeTotals(s).tokens
      return round((t.input + t.output + t.cacheRead + t.cacheWrite) / 1_000_000, 2)
    },
  },
  { key: 'cost', label: 'cost (USD)', type: 'NUMBER', value: s => usd(computeTotals(s).costUsd) },
  {
    key: 'value',
    label: 'API value (USD)',
    type: 'NUMBER',
    value: s => usd(computeTotals(s).valueUsd),
  },
  {
    key: 'errors',
    label: 'errors',
    type: 'NUMBER',
    value: s => {
      const t = computeTotals(s)
      return t.errors + t.interruptions
    },
  },
  { key: 'model', label: 'model', type: 'SINGLE_SELECT', value: mainModel },
  {
    key: 'lastSession',
    label: 'last session',
    type: 'DATE',
    value: s =>
      s.length === 0
        ? null
        : (s
            .map(x => x.endedAt)
            .sort()
            .at(-1)
            ?.slice(0, 10) ?? null),
  },
  { key: 'buildSessions', label: 'build sessions', type: 'NUMBER', value: s => build(s).length },
  {
    key: 'followUpSessions',
    label: 'follow-up sessions',
    type: 'NUMBER',
    value: s => followUp(s).length,
  },
  {
    key: 'followUpMinutes',
    label: 'follow-up minutes',
    type: 'NUMBER',
    value: s => minutes(computeTotals(followUp(s)).durationMs),
  },
  {
    key: 'followUpCost',
    label: 'follow-up cost (USD)',
    type: 'NUMBER',
    value: s => usd(computeTotals(followUp(s)).costUsd),
  },
]

export interface FieldOptions {
  /** Put in front of every field name so ours never collide with the board's own. */
  prefix?: string
  /** Keys of the fields to keep; all of them when absent. */
  fields?: string[]
}

export interface ResolvedField {
  key: string
  name: string
  type: FieldType
  value: FieldValue
}

/** The fields in use, with their full names and this PR's values. */
export function fieldValues(sessions: DataSession[], options: FieldOptions = {}): ResolvedField[] {
  const prefix = options.prefix ?? DEFAULT_PREFIX
  return FIELDS.filter(f => !options.fields || options.fields.includes(f.key)).map(f => ({
    key: f.key,
    name: `${prefix}${f.label}`,
    type: f.type,
    value: f.value(sessions),
  }))
}

/** Unknown keys in a `boardFields` setting, so setup and status can point them out. */
export function unknownFieldKeys(keys: string[] | undefined): string[] {
  return (keys ?? []).filter(k => !FIELDS.some(f => f.key === k))
}

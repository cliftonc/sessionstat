import { type DataSession, type DataTotals, computeTotals } from './data.js'
import { MAX_GAP_HOURS, buildTimeline } from './timeline.js'

/**
 * Everything a template can use. Built from the merged session state (local sessions plus the
 * ones already in the comment's data block), so the comment never loses a session.
 *
 * Numbers arrive already formatted as strings, so templates never do maths; booleans exist so
 * optional sections can be hidden with `{{#flag}}`.
 */
export interface CommentView {
  pr: { number: number; url: string; branch: string } | null
  repo: string
  branch: string
  generatedAt: string
  multipleSessions: boolean
  singleSession: boolean
  hasErrors: boolean
  /** Some session was covered by a Claude subscription ("plan" in `billed`). */
  hasPlan: boolean
  /** Some test run failed. */
  testsFailing: boolean
  /** Some session has a known cost: spend, or a subscription. */
  hasCost: boolean
  /** Some session has an API value. */
  hasValue: boolean
  hasTests: boolean
  /** There are sessions from before the PR was opened / after it. */
  hasBuild: boolean
  hasFollowUp: boolean
  /** Both build and follow-up sessions: worth a label row per group. */
  bothPhases: boolean
  /** `2 build, 1 follow-up`. */
  phaseSummary: string
  /** Build sessions then follow-up sessions, each with a label. Empty groups are left out. */
  groups: Array<{ label: string; sessions: SessionView[] }>
  /** The axis of every session's `timeline` bar. */
  timeline: {
    /** `Oct 14 09:00` */
    from: string
    to: string
    /** Real minutes per character of a bar. */
    minutesPerChar: number
    /** Some idle time was cut, drawn as `||`. */
    hasBreaks: boolean
    breakHours: number
  }
  totals: TotalsView
  sessions: SessionView[]
  /** Sessions that built the branch: they started before the PR existed. */
  buildSessions: SessionView[]
  /** Sessions that started after the PR was opened: review responses and fixes. */
  followUpSessions: SessionView[]
  buildTotals: TotalsView
  followUpTotals: TotalsView
}

export interface TokensView {
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
  /** All four added up. */
  total: string
}

export interface TotalsView {
  sessionCount: number
  sessionNoun: string
  duration: string
  turns: number
  toolCalls: number
  filesEdited: number
  commits: number
  tokens: TokensView
  /**
   * Actual spend: `$1.23`, `subscription`, `$1.23 + subscription` when mixed, or `–` when
   * unknown. Never includes the value of subscription sessions.
   */
  cost: string
  /**
   * `cost` for a table cell: `$1.23`, `plan` (a Claude subscription), or
   * `$1.23<br><sub>+ plan</sub>` when mixed.
   */
  billed: string
  /** List-price value of every priced session, subscription included, or `–`. */
  value: string
  /** Some sessions have no value (an unpriced model), so `value` is a floor. */
  valuePartial: boolean
  /** Some sessions' spend is unknown, so `cost` is not the whole bill. */
  costPartial: boolean
  hasCost: boolean
  hasValue: boolean
  hasTests: boolean
  errors: number
  interruptions: number
  compactions: number
  testRuns: { passed: number; failed: number }
  successRate: string
}

export interface SessionView {
  id: string
  shortId: string
  author: string
  model: string
  /** `Opus 5.5` for `claude-opus-5-5`; the model id when it does not parse. */
  modelName: string
  startedAt: string
  /** `Oct 14 09:00`, UTC. */
  started: string
  /** The session's bar on the shared timeline, for inside backticks in a table cell. */
  timeline: string
  duration: string
  openedBeforePr: boolean
  phase: string
  /** `Build` or `Follow-up`. */
  phaseLabel: string
  turns: number
  toolCalls: number
  tools: Array<{ name: string; count: number }>
  filesEdited: number
  commits: Array<{ sha: string; short: string }>
  commitCount: number
  tokens: TokensView
  billing: string
  /** `$1.23` when billed per token, `subscription`, or `–` when unknown or unpriced. */
  cost: string
  /** `cost` for a table cell: `plan` for a subscription. */
  billed: string
  /** List-price value, or `–` when the model is unpriced. */
  value: string
  errors: number
  interruptions: number
  compactions: number
  testRuns: { passed: number; failed: number }
  successRate: string
  processQuality: string
  iterations: number
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.round(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `${trim(n / 1_000)}k`
  return String(n)
}

function trim(n: number): string {
  return n >= 100 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, '')
}

export function formatCost(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd)) return ''
  return `$${usd.toFixed(2)}`
}

const NONE = '–'

function sessionCost(s: DataSession): string {
  if (s.billing === 'subscription') return 'subscription'
  return s.costUsd === null ? NONE : formatCost(s.costUsd)
}

function totalCost(t: DataTotals): string {
  const subscription = t.billing.subscription > 0
  if (t.costUsd === null) return subscription ? 'subscription' : NONE
  return subscription ? `${formatCost(t.costUsd)} + subscription` : formatCost(t.costUsd)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Oct 14 09:00`: UTC, for a table cell. */
export function formatShortTime(date: Date | string | number): string {
  const d = new Date(date)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** `claude-opus-5-5` → `Opus 5.5`, `claude-sonnet-4-5-20250929` → `Sonnet 4.5`. */
export function formatModel(model: string | null): string {
  if (!model) return 'unknown'
  if (!model.startsWith('claude-')) return model
  const parts = model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .split('-')
  const family = parts.find(p => /^[a-z]+$/i.test(p))
  const version = parts.filter(p => /^\d+$/.test(p))
  if (!family || version.length === 0) return model
  return `${family[0].toUpperCase()}${family.slice(1)} ${version.join('.')}`
}

/** UTC, minute precision: a comment is read by people in many time zones. */
export function formatTimestamp(date: Date | string): string {
  return `${new Date(date).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function tokensView(t: DataSession['tokens']): TokensView {
  return {
    input: formatTokens(t.input),
    output: formatTokens(t.output),
    cacheRead: formatTokens(t.cacheRead),
    cacheWrite: formatTokens(t.cacheWrite),
    total: formatTokens(t.input + t.output + t.cacheRead + t.cacheWrite),
  }
}

function sessionBilled(s: DataSession): string {
  return s.billing === 'subscription' ? 'plan' : sessionCost(s)
}

function totalBilled(t: DataTotals): string {
  const plan = t.billing.subscription > 0
  if (t.costUsd === null) return plan ? 'plan' : NONE
  return plan ? `${formatCost(t.costUsd)}<br><sub>+ plan</sub>` : formatCost(t.costUsd)
}

function sessionView(s: DataSession, timeline = ''): SessionView {
  return {
    id: s.id,
    shortId: s.id.slice(0, 8),
    author: s.author ?? '–',
    model: s.model ?? 'unknown',
    modelName: formatModel(s.model),
    startedAt: formatTimestamp(s.startedAt),
    started: formatShortTime(s.startedAt),
    timeline,
    duration: formatDuration(s.durationMs),
    openedBeforePr: s.openedBeforePr,
    phase: s.openedBeforePr ? 'follow-up' : 'build',
    phaseLabel: s.openedBeforePr ? 'Follow-up' : 'Build',
    turns: s.turns,
    toolCalls: s.toolCalls,
    tools: s.tools,
    filesEdited: s.filesEdited,
    commits: s.commits.map(sha => ({ sha, short: sha.slice(0, 7) })),
    commitCount: s.commits.length,
    tokens: tokensView(s.tokens),
    billing: s.billing,
    cost: sessionCost(s),
    billed: sessionBilled(s),
    value: s.valueUsd === null ? NONE : formatCost(s.valueUsd),
    errors: s.errors,
    interruptions: s.interruptions,
    compactions: s.compactions,
    testRuns: s.testRuns,
    successRate: `${s.successRate}%`,
    processQuality: `${s.processQuality}%`,
    iterations: s.iterations,
  }
}

function totalsView(t: DataTotals): TotalsView {
  const hasCost = t.costUsd !== null || t.billing.subscription > 0
  const hasValue = t.valueUsd !== null
  return {
    sessionCount: t.sessions,
    sessionNoun: t.sessions === 1 ? 'session' : 'sessions',
    duration: formatDuration(t.durationMs),
    turns: t.turns,
    toolCalls: t.toolCalls,
    filesEdited: t.filesEdited,
    commits: t.commits,
    tokens: tokensView(t.tokens),
    cost: totalCost(t),
    billed: totalBilled(t),
    value: hasValue ? formatCost(t.valueUsd) : NONE,
    valuePartial: t.valuePartial,
    costPartial: t.costPartial,
    hasCost,
    hasValue,
    hasTests: t.testRuns.passed + t.testRuns.failed > 0,
    errors: t.errors,
    interruptions: t.interruptions,
    compactions: t.compactions,
    testRuns: t.testRuns,
    successRate: `${t.successRate}%`,
  }
}

export interface BuildViewInput {
  sessions: DataSession[]
  pr: { number: number; url: string; headRefName: string } | null
  repo: string
  branch: string
  now?: Date
}

export function buildView(input: BuildViewInput): CommentView {
  const sessions = input.sessions
  const build = sessions.filter(s => !s.openedBeforePr)
  const followUp = sessions.filter(s => s.openedBeforePr)
  const totals = totalsView(computeTotals(sessions))

  const time = (iso: string) => new Date(iso).getTime()
  const axis = buildTimeline(
    sessions.map(s => ({ start: time(s.startedAt), end: time(s.startedAt) + s.durationMs }))
  )
  const bars = new Map(sessions.map((s, i) => [s, axis.bars[i]]))
  const view = (s: DataSession) => sessionView(s, bars.get(s))
  const groups = [
    { label: 'Build', sessions: build.map(view) },
    { label: 'Follow-up', sessions: followUp.map(view) },
  ].filter(g => g.sessions.length > 0)

  return {
    pr: input.pr
      ? { number: input.pr.number, url: input.pr.url, branch: input.pr.headRefName }
      : null,
    repo: input.repo,
    branch: input.branch,
    generatedAt: formatTimestamp(input.now ?? new Date()),
    multipleSessions: sessions.length > 1,
    singleSession: sessions.length === 1,
    hasErrors: totals.errors > 0,
    hasPlan: sessions.some(s => s.billing === 'subscription'),
    testsFailing: totals.testRuns.failed > 0,
    hasCost: totals.hasCost,
    hasValue: totals.hasValue,
    hasTests: totals.hasTests,
    hasBuild: build.length > 0,
    hasFollowUp: followUp.length > 0,
    bothPhases: build.length > 0 && followUp.length > 0,
    phaseSummary: [
      build.length > 0 ? `${build.length} build` : '',
      followUp.length > 0 ? `${followUp.length} follow-up` : '',
    ]
      .filter(Boolean)
      .join(', '),
    groups,
    timeline: {
      from: sessions.length > 0 ? formatShortTime(axis.from) : '',
      to: sessions.length > 0 ? formatShortTime(axis.to) : '',
      minutesPerChar: Math.max(1, Math.round(axis.msPerChar / 60_000)),
      hasBreaks: axis.breaks > 0,
      breakHours: MAX_GAP_HOURS,
    },
    totals,
    sessions: sessions.map(view),
    buildSessions: build.map(view),
    followUpSessions: followUp.map(view),
    buildTotals: totalsView(computeTotals(build)),
    followUpTotals: totalsView(computeTotals(followUp)),
  }
}

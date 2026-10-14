/**
 * Transcript in, numbers out.
 *
 * Runs the parser and the metric processors copied from guidemode the same way guidemode's
 * `ClaudeCodeProcessor.processMetrics` does - parse, attach the `cost-state` totals, run each
 * processor, skip any that fail - then adds the few counts the PR comment needs that guidemode
 * has no processor for (files edited, test runs, per-tool counts, compactions).
 */

import { CanonicalParser } from './canonical-parser.js'
import { ClaudeCostStateExtractor } from './claude-cost-state.js'
import { CanonicalCostProcessor } from './cost.js'
import { CanonicalEngagementProcessor } from './engagement.js'
import { CanonicalErrorProcessor } from './error.js'
import { isHumanPrompt } from './message-filters.js'
import type { BaseMetricProcessor } from './metric-processor.js'
import { CanonicalPerformanceProcessor } from './performance.js'
import { sessionValueUsd } from './pricing.js'
import { CanonicalQualityProcessor } from './quality.js'
import { attributeTokens } from './token-attribution.js'
import { getToolCapability } from './tool-capabilities.js'
import {
  type EngagementMetrics,
  type ErrorMetrics,
  type ParsedSession,
  type PerformanceMetrics,
  type QualityMetrics,
  type TokenCostMetrics,
  type ToolResultContent,
  type ToolUseContent,
  type UsageMetrics,
  isStructuredMessageContent,
} from './types.js'
import { CanonicalUsageProcessor } from './usage.js'

export interface SessionStats {
  sessionId: string
  model: string | null
  startedAt: Date
  endedAt: Date
  durationMs: number
  /** Prompts the person typed (sub-agent prompts excluded), as guidemode counts them. */
  turns: number
  toolCalls: number
  tools: Array<{ name: string; count: number }>
  filesEdited: string[]
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /**
   * List-price value of the session's tokens: Claude Code's own `cost-state` figure once it has
   * written one, otherwise priced from the vendored rate table. Null when a model is unpriced.
   * Value, not spend - whether anyone is invoiced depends on the billing mode.
   */
  valueUsd: number | null
  /** Tool results seen, and those that came back flagged `is_error`. */
  toolResults: number
  errors: number
  /** guidemode's heuristic error count (explicit errors plus error-looking tool output). */
  errorSignals: number
  interruptions: number
  compactions: number
  testRuns: { passed: number; failed: number }
  /** guidemode quality metrics, unchanged. */
  successRate: number
  processQuality: number
  iterations: number
  usedPlanMode: boolean
  readWriteRatio: number
  linesAdded: number | null
  linesRemoved: number | null
}

/** The raw guidemode metric objects, keyed by metric type, for `template vars --raw`. */
export interface RawMetrics {
  performance?: PerformanceMetrics
  engagement?: EngagementMetrics
  quality?: QualityMetrics
  usage?: UsageMetrics
  error?: ErrorMetrics
  'token-cost'?: TokenCostMetrics
}

/**
 * Commands that run a test suite. Deliberately conservative: a false "tests passed" on a PR is
 * worse than not mentioning tests at all.
 */
const TEST_COMMAND =
  /(^|[\s;&|(])((npx|pnpm|yarn|bunx?)\s+(run\s+)?)?(vitest|jest|mocha|ava|playwright\s+test|pytest|rspec|phpunit)\b|(^|[\s;&|(])(npm|pnpm|yarn|bun)\s+(run\s+)?test(:\S+)?\b|(^|[\s;&|(])(go|cargo|deno|dotnet|mix|swift)\s+test\b|(^|[\s;&|(])python3?\s+-m\s+(pytest|unittest)\b|(^|[\s;&|(])(make|just)\s+test\b/

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command)
}

function processors(): BaseMetricProcessor[] {
  return [
    new CanonicalPerformanceProcessor(),
    new CanonicalEngagementProcessor(),
    new CanonicalQualityProcessor(),
    new CanonicalUsageProcessor(),
    new CanonicalErrorProcessor(),
    new CanonicalCostProcessor(),
  ]
}

/** Parse a transcript the way guidemode does, with the provider totals attached. */
export function parseTranscript(jsonl: string): ParsedSession {
  const session = new CanonicalParser().parseSession(jsonl)
  session.provider = 'claude-code'
  try {
    session.providerTotals = new ClaudeCostStateExtractor().extract(jsonl.split('\n')) ?? undefined
  } catch {
    // Strictly additive, as in guidemode.
  }
  return session
}

/** Every guidemode metric processor over the session. A failing processor is skipped. */
export async function runMetricProcessors(session: ParsedSession): Promise<RawMetrics> {
  const raw: Record<string, unknown> = {}
  for (const processor of processors()) {
    try {
      if (!processor.canProcess(session)) continue
      const result = await processor.processToResult(session)
      if (result?.metrics) raw[result.metricType] = result.metrics
    } catch {
      // Same contract as guidemode's BaseProviderProcessor: silently continue.
    }
  }
  return raw as RawMetrics
}

function toolUsesOf(session: ParsedSession): ToolUseContent[] {
  const uses: ToolUseContent[] = []
  for (const message of session.messages) {
    if (isStructuredMessageContent(message.content) && message.content.toolUse) {
      uses.push(message.content.toolUse)
    }
  }
  return uses
}

function toolResultsById(session: ParsedSession): Map<string, ToolResultContent> {
  const results = new Map<string, ToolResultContent>()
  for (const message of session.messages) {
    if (isStructuredMessageContent(message.content) && message.content.toolResult) {
      results.set(message.content.toolResult.tool_use_id, message.content.toolResult)
    }
  }
  return results
}

function editedPath(tool: ToolUseContent): string | null {
  if (getToolCapability(tool.name) !== 'write') return null
  const input = tool.input as { file_path?: unknown; notebook_path?: unknown; path?: unknown }
  const path = [input.file_path, input.notebook_path, input.path].find(
    (p): p is string => typeof p === 'string' && p.length > 0
  )
  // A plan file is planning, not a change to the code under review.
  if (!path || path.includes('/.claude/plans/')) return null
  return path
}

/**
 * Compactions. Claude Code writes a `system` line with `subtype: "compact_boundary"` for
 * every compaction, manual or automatic; the parser drops it because it carries no `message`,
 * so it is counted from the raw lines. guidemode's `/compact` command count is the fallback
 * for older transcripts that predate the boundary record.
 */
function countCompactions(jsonl: string, session: ParsedSession): number {
  let boundaries = 0
  for (const line of jsonl.split('\n')) {
    if (!line.includes('compact_boundary')) continue
    try {
      const record = JSON.parse(line) as { subtype?: unknown }
      if (record.subtype === 'compact_boundary') boundaries++
    } catch {
      // Not a record.
    }
  }
  if (boundaries > 0) return boundaries
  return session.messages.filter(m => m.type === 'compact').length
}

export async function computeSessionStats(
  jsonl: string
): Promise<{ stats: SessionStats; raw: RawMetrics }> {
  const session = parseTranscript(jsonl)
  const raw = await runMetricProcessors(session)

  const uses = toolUsesOf(session)
  const results = toolResultsById(session)

  const toolCounts = new Map<string, number>()
  for (const use of uses) toolCounts.set(use.name, (toolCounts.get(use.name) ?? 0) + 1)
  const tools = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const filesEdited = [...new Set(uses.map(editedPath).filter((p): p is string => p !== null))]

  const testRuns = { passed: 0, failed: 0 }
  for (const use of uses) {
    if (getToolCapability(use.name) !== 'execute') continue
    const command = (use.input as { command?: unknown }).command
    if (typeof command !== 'string' || !isTestCommand(command)) continue
    const result = results.get(use.id)
    if (!result) continue // Still running, or the session was cut off.
    if (result.is_error) testRuns.failed++
    else testRuns.passed++
  }

  const errors = [...results.values()].filter(r => r.is_error).length
  const attribution = attributeTokens(session)
  const cost = raw['token-cost']

  const stats: SessionStats = {
    sessionId: session.sessionId,
    model: cost?.primary_model ?? attribution.primaryModel,
    startedAt: session.startTime,
    endedAt: session.endTime,
    durationMs: session.duration,
    turns: session.messages.filter(isHumanPrompt).length,
    toolCalls: uses.length,
    tools,
    filesEdited,
    tokens: {
      input: attribution.totals.inputTokens,
      output: attribution.totals.outputTokens,
      cacheRead: attribution.totals.cacheReadTokens,
      cacheWrite: attribution.totals.cacheCreationTokens,
    },
    valueUsd: session.providerTotals?.reportedCostUsd ?? sessionValueUsd(session),
    toolResults: results.size,
    errors,
    errorSignals: raw.error?.error_count ?? 0,
    interruptions: raw.engagement?.total_interruptions ?? 0,
    compactions: countCompactions(jsonl, session),
    testRuns,
    successRate: raw.quality?.task_success_rate ?? 0,
    processQuality: raw.quality?.process_quality_score ?? 0,
    iterations: raw.quality?.iteration_count ?? 0,
    usedPlanMode: raw.quality?.used_plan_mode ?? false,
    readWriteRatio: raw.usage?.read_write_ratio ?? 0,
    linesAdded: session.providerTotals?.agentLines?.added ?? null,
    linesRemoved: session.providerTotals?.agentLines?.removed ?? null,
  }

  return { stats, raw }
}

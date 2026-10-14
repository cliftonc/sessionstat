/**
 * Claude Code `cost-state` extractor
 *
 * Claude Code appends a final record of the form:
 *
 *   {"type":"cost-state","sessionId":"...","totalCostUSD":5.599,"totalAPIDuration":733434,
 *    "totalToolDuration":207982,"totalLinesAdded":1733,"totalLinesRemoved":121,
 *    "totalDuration":2361174,"startTime":1787817807272,
 *    "modelUsage":{"claude-opus-5[1m]":{"inputTokens":220,"outputTokens":54745,
 *      "cacheReadInputTokens":5668844,"cacheCreationInputTokens":139372,
 *      "webSearchRequests":0,"costUSD":5.597867}},
 *    "hasUnknownModelCost":false}
 *
 * It is cumulative and, in every transcript observed, the final line. We still scan
 * backwards over a small window rather than requiring the last line, so a trailing
 * newline or a future trailing record does not lose the data.
 *
 * Fields are read individually with explicit type checks rather than validated against a
 * schema: a new or renamed field upstream must degrade one value, never drop the record.
 */

import type { ProviderModelUsage, ProviderSessionTotals, SessionTotalsExtractor } from './types.js'

/** How far back from the end to look. Observed position is always the last line. */
const TAIL_SCAN_LINES = 50

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numOr0(value: unknown): number {
  return num(value) ?? 0
}

function parseModelUsage(raw: unknown): ProviderModelUsage[] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined

  const models: ProviderModelUsage[] = []
  for (const [model, usage] of Object.entries(raw as Record<string, unknown>)) {
    if (!usage || typeof usage !== 'object') continue
    const u = usage as Record<string, unknown>
    models.push({
      model,
      inputTokens: numOr0(u.inputTokens),
      outputTokens: numOr0(u.outputTokens),
      cacheCreationTokens: numOr0(u.cacheCreationInputTokens),
      cacheReadTokens: numOr0(u.cacheReadInputTokens),
      webSearchRequests: num(u.webSearchRequests),
      reportedCostUsd: num(u.costUSD),
    })
  }

  return models.length > 0 ? models : undefined
}

export class ClaudeCostStateExtractor implements SessionTotalsExtractor {
  readonly providers = ['claude-code', 'claude'] as const

  extract(lines: string[]): ProviderSessionTotals | null {
    const start = Math.max(0, lines.length - TAIL_SCAN_LINES)

    for (let i = lines.length - 1; i >= start; i--) {
      const line = lines[i]?.trim()
      if (!line || !line.includes('"cost-state"')) continue

      let record: Record<string, unknown>
      try {
        record = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (record.type !== 'cost-state') continue

      const modelUsage = parseModelUsage(record.modelUsage)

      return {
        source: 'claude-cost-state',
        modelUsage,
        reportedCostUsd: num(record.totalCostUSD),
        hasUnknownModelCost:
          typeof record.hasUnknownModelCost === 'boolean' ? record.hasUnknownModelCost : undefined,
        durations: {
          apiMs: num(record.totalAPIDuration),
          apiWithoutRetriesMs: num(record.totalAPIDurationWithoutRetries),
          toolMs: num(record.totalToolDuration),
          wallClockMs: num(record.totalDuration),
        },
        agentLines:
          num(record.totalLinesAdded) !== undefined || num(record.totalLinesRemoved) !== undefined
            ? { added: numOr0(record.totalLinesAdded), removed: numOr0(record.totalLinesRemoved) }
            : undefined,
      }
    }

    return null
  }
}

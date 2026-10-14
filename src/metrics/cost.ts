/**
 * Token & cost metrics processor
 *
 * Turns the session's token attribution and the provider's own summary record into the
 * metrics the server persists. It does NOT compute the headline cost: that is derived
 * from the price table server-side, because pricing needs database access this package
 * does not have. What it produces is everything pricing needs as input, plus the
 * provider's own cost figure for cross-checking.
 */

import { BaseMetricProcessor } from './metric-processor.js'
import { attributeTokens } from './token-attribution.js'
import type { SessionModelUsage, TokenCostMetrics } from './types.js'
import type { ParsedSession } from './types.js'

export class CanonicalCostProcessor extends BaseMetricProcessor {
  readonly name = 'canonical-cost'
  readonly metricType = 'token-cost' as const
  readonly description =
    'Per-model token attribution and provider-reported cost, for API-equivalent cost derivation'

  canProcess(session: ParsedSession): boolean {
    return Boolean(session.providerTotals) || session.messages.some(m => m.metadata?.usage)
  }

  async process(session: ParsedSession): Promise<TokenCostMetrics> {
    const attribution = attributeTokens(session)
    const provider = session.providerTotals

    // Per-model reported cost, so a later comparison can be made model by model rather
    // than only in aggregate — that is what reveals a single mispriced model.
    const reportedByModel = new Map((provider?.modelUsage ?? []).map(m => [m.model, m] as const))

    const modelUsage: SessionModelUsage[] = attribution.models.map(m => {
      const reported = reportedByModel.get(m.model)
      return {
        model: m.model,
        input_tokens: m.inputTokens,
        output_tokens: m.outputTokens,
        cache_creation_tokens: m.cacheCreationTokens,
        cache_creation_1h_tokens: m.cacheCreation1hTokens,
        cache_read_tokens: m.cacheReadTokens,
        reasoning_tokens: m.reasoningTokens,
        web_search_requests: reported?.webSearchRequests,
        reported_cost_usd: reported?.reportedCostUsd,
      }
    })

    const webSearchRequests = (provider?.modelUsage ?? []).reduce(
      (n, m) => n + (m.webSearchRequests ?? 0),
      0
    )

    return {
      token_attribution_source: attribution.source,
      model_usage: modelUsage,
      primary_model: attribution.primaryModel,
      distinct_model_count: attribution.distinctModelCount,
      total_reasoning_tokens: attribution.totals.reasoningTokens,
      duplicate_request_count: attribution.duplicateRequestCount,

      provider_reported_cost_usd: provider?.reportedCostUsd,
      provider_reported_source: provider?.source,
      provider_has_unknown_model_cost: provider?.hasUnknownModelCost,

      api_duration_ms: provider?.durations?.apiMs,
      api_duration_without_retries_ms: provider?.durations?.apiWithoutRetriesMs,
      tool_duration_ms: provider?.durations?.toolMs,
      agent_wall_clock_ms: provider?.durations?.wallClockMs,

      agent_lines_added: provider?.agentLines?.added,
      agent_lines_removed: provider?.agentLines?.removed,
      web_search_requests: webSearchRequests > 0 ? webSearchRequests : undefined,
    }
  }
}

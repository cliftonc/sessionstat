/**
 * The types the copied parser and metric processors need, and nothing else.
 *
 * Copied from guidemode's `packages/types` (content blocks, provider totals, metric shapes)
 * and `packages/session-processing/src/parsers/base/types.ts` (parsed session). guidemode
 * has two `ParsedSession` definitions, one per package; here there is one.
 */

// ---------------------------------------------------------------------------
// Content blocks (packages/types/src/providers/shared/content-blocks.ts)
// ---------------------------------------------------------------------------

export interface TextContent {
  type: 'text'
  text: string
}

export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultContent {
  type: 'tool_result'
  tool_use_id: string
  content: unknown
  is_error?: boolean
}

export interface ImageContent {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

/**
 * Structured message content with parsed components. Exactly one of text / toolUse /
 * toolResult is the point of a given message; images travel with text.
 */
export interface StructuredMessageContent {
  type: 'structured'
  text?: string
  toolUse?: ToolUseContent
  toolResult?: ToolResultContent
  images?: ImageContent[]
}

export type MessageContent = string | StructuredMessageContent

export function isStructuredMessageContent(
  content: MessageContent | unknown
): content is StructuredMessageContent {
  return (
    typeof content === 'object' &&
    content !== null &&
    !Array.isArray(content) &&
    'type' in content &&
    (content as { type: unknown }).type === 'structured'
  )
}

// ---------------------------------------------------------------------------
// Provider totals (packages/types/src/sessions/provider-totals.ts)
// ---------------------------------------------------------------------------

export interface ProviderModelUsage {
  /** Model id exactly as written, e.g. 'claude-opus-5[1m]'. Never normalised here. */
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  webSearchRequests?: number
  reportedCostUsd?: number
}

export interface ProviderSessionTotals {
  source: 'claude-cost-state'
  modelUsage?: ProviderModelUsage[]
  /** Session-wide totals for providers that give no per-model split. Never set for Claude. */
  totals?: {
    inputTokens: number
    outputTokens: number
    cacheCreationTokens: number
    cacheReadTokens: number
    reasoningTokens?: number
  }
  reportedCostUsd?: number
  hasUnknownModelCost?: boolean
  durations?: {
    apiMs?: number
    apiWithoutRetriesMs?: number
    toolMs?: number
    wallClockMs?: number
  }
  agentLines?: { added: number; removed: number }
}

// ---------------------------------------------------------------------------
// Parsed session (packages/session-processing/src/parsers/base/types.ts)
// ---------------------------------------------------------------------------

export interface RawLogMessage {
  timestamp: string
  [key: string]: unknown
}

export type UnifiedMessageType =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'command'
  | 'command_output'
  | 'interruption'
  | 'compact'
  | 'meta'

export interface ParsedMessage {
  id: string
  timestamp: Date
  type: UnifiedMessageType
  content: MessageContent
  metadata: {
    role?: string
    parentUuid?: string
    requestId?: string
    userType?: string
    hasToolUses?: boolean
    hasToolResults?: boolean
    toolCount?: number
    resultCount?: number
    providerMetadata?: Record<string, unknown>
    [key: string]: unknown
  }
  parentId?: string
  linkedTo?: string
}

export interface ParsedSession {
  sessionId: string
  provider: string
  messages: ParsedMessage[]
  startTime: Date
  endTime: Date
  duration: number
  metadata: {
    messageCount: number
    lineCount: number
    [key: string]: unknown
  }
  providerTotals?: ProviderSessionTotals
}

// ---------------------------------------------------------------------------
// Metric shapes (packages/types/src/metrics/*.ts)
// ---------------------------------------------------------------------------

export type MetricType = 'performance' | 'usage' | 'error' | 'engagement' | 'quality' | 'token-cost'

interface BaseMetrics {
  [key: string]: string | number | boolean | object | null | undefined
}

export interface PerformanceMetrics extends BaseMetrics {
  response_latency_ms: number
  task_completion_time_ms: number
  metadata?: {
    total_responses: number
    improvement_tips: string[]
  }
}

export interface UsageMetrics extends BaseMetrics {
  read_write_ratio: number
  input_clarity_score: number
  metadata?: {
    read_operations: number
    write_operations: number
    total_user_messages: number
    total_lines_read?: number
    ratio_quality?: 'excellent' | 'acceptable' | 'poor'
    improvement_tips: string[]
  }
}

export interface ErrorMetrics extends BaseMetrics {
  error_count?: number
  error_types?: string[]
  last_error_message?: string
  recovery_attempts?: number
  fatal_errors?: number
  metadata?: {
    improvement_tips?: string[]
  }
}

export interface EngagementMetrics extends BaseMetrics {
  interruption_rate: number
  total_interruptions: number
  session_length_minutes: number
  metadata?: {
    total_responses: number
    improvement_tips: string[]
  }
}

export interface QualityMetrics extends BaseMetrics {
  task_success_rate: number
  iteration_count: number
  process_quality_score: number
  used_plan_mode: boolean
  used_todo_tracking: boolean
  over_top_affirmations: number
  metadata?: {
    successful_operations: number
    total_operations: number
    improvement_tips: string[]
    exit_plan_mode_count?: number
    todo_write_count?: number
    over_top_affirmations_phrases?: string[]
    process_quality_scorer_version?: string
  }
}

export interface SessionModelUsage {
  model: string
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_creation_1h_tokens?: number
  cache_read_tokens: number
  reasoning_tokens: number
  web_search_requests?: number
  reported_cost_usd?: number
}

export interface TokenCostMetrics extends BaseMetrics {
  token_attribution_source: string
  model_usage: SessionModelUsage[]
  primary_model: string | null
  distinct_model_count: number
  total_reasoning_tokens: number
  duplicate_request_count: number
  provider_reported_cost_usd?: number
  provider_reported_source?: string
  provider_has_unknown_model_cost?: boolean
  api_duration_ms?: number
  api_duration_without_retries_ms?: number
  tool_duration_ms?: number
  agent_wall_clock_ms?: number
  agent_lines_added?: number
  agent_lines_removed?: number
  web_search_requests?: number
}

export type SessionMetricsData =
  | PerformanceMetrics
  | UsageMetrics
  | ErrorMetrics
  | EngagementMetrics
  | QualityMetrics
  | TokenCostMetrics

// ---------------------------------------------------------------------------
// Parser and processor plumbing (session-processing parsers/base/types.ts,
// types/src/processor.ts, extractors/types.ts)
// ---------------------------------------------------------------------------

export interface ContentPart {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  data?: string
  source?: {
    data?: string
    media_type?: string
  }
  thinking?: string
  signature?: string
}

export interface SessionParser {
  readonly name: string
  readonly providerName: string
  canParse(jsonlContent: string): boolean
  parseSession(jsonlContent: string): ParsedSession
  parseMessage(rawMessage: RawLogMessage): ParsedMessage[]
}

export interface ProcessorResult {
  metricType: MetricType
  metrics: SessionMetricsData
  processingTime: number
  metadata: {
    processor: string
    processingTime: number
    messageCount: number
    sessionDuration: number
  }
}

export interface SessionTotalsExtractor {
  readonly providers: readonly string[]
  extract(lines: string[]): ProviderSessionTotals | null
}

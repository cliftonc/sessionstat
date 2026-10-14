/**
 * Token attribution
 *
 * Single source of truth for turning a parsed session into token counts, both
 * per-model and in total. Both figures come from one pass so they can never drift.
 *
 * The important correctness rule lives here: Claude Code writes SEVERAL JSONL lines
 * for one assistant response — a text line, tool_use lines, thinking lines — and every
 * one of them repeats the SAME `usage` block for the request that produced them. Summing
 * per message therefore counts the same tokens many times over. Measured on a real
 * session: 622 usage-bearing messages but only 257 distinct requests, inflating
 * output_tokens by 64.8% (487,244 vs 171,655).
 *
 * Deduplicating on `requestId` is what makes these numbers real.
 *
 * The second rule concerns the CACHE TTL SPLIT. Anthropic bills a 1-hour cache write at
 * a higher rate than the 5-minute default, and only the per-message `usage.cache_creation`
 * object carries that breakdown — the provider's own summary record does not. So when the
 * summary is authoritative (it is, for Claude) the TTL split still has to come from the
 * messages, and the two sources do not always cover the same requests: on a resumed or
 * compacted session the summary bills tokens whose messages are in a different file
 * entirely. Measured across 15 real sessions, message-visible cache-creation tokens
 * ranged from 7% to 485% of the summary's figure for the same model.
 *
 * That is why the observed 1-hour count is CAPPED at the authoritative total and never
 * extrapolated from it. Extrapolating the observed ratio looked more accurate on average
 * (-7.7% -> +5.0% against Anthropic's own figures) but over-stated 8 of 15 sessions by up
 * to 8%, with nothing stored to say which. Capping is exact wherever the two sources
 * reconcile, strictly better than ignoring the split on every session measured, and its
 * error is one-sided: the derived cost is a floor, never an over-charge.
 */

import type { ParsedMessage, ParsedSession } from './types.js'

/** Raw usage block as it appears on a message, across providers. */
interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  /** TTL breakdown of the line above. Anthropic bills 1-hour writes at a higher rate. */
  cache_creation?: {
    ephemeral_1h_input_tokens?: number
    ephemeral_5m_input_tokens?: number
  }
  cache_read_input_tokens?: number
  output_tokens_details?: { reasoning_tokens?: number }
  reasoning_output_tokens?: number
}

export interface ModelTokenUsage {
  /** Model id exactly as the provider wrote it, e.g. 'claude-opus-5[1m]'. Never normalised here. */
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  /**
   * Portion of `cacheCreationTokens` written with a 1-hour TTL, which Anthropic bills
   * at a higher rate than the 5-minute default ($10/Mtok against $6.25 for Opus 5).
   *
   * ALWAYS <= `cacheCreationTokens`, and deliberately an under-count when the two
   * sources disagree. See `observed1hByBaseModel`.
   */
  cacheCreation1hTokens: number
  cacheReadTokens: number
  reasoningTokens: number
}

export interface TokenTotals {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  reasoningTokens: number
}

export interface TokenAttribution {
  /**
   * Where the numbers came from.
   * - `provider_totals`: the provider's own per-model record (authoritative)
   * - `mixed`: provider totals, with the per-model split derived from messages
   * - `message_usage`: everything derived from per-message usage
   */
  source: 'provider_totals' | 'mixed' | 'message_usage'
  /** Per-model breakdown, highest output first. */
  models: ModelTokenUsage[]
  totals: TokenTotals
  /** Model that produced the most output tokens — the session's representative model. */
  primaryModel: string | null
  distinctModelCount: number
  /** Requests whose usage was seen more than once and counted only once. Diagnostic. */
  duplicateRequestCount: number
}

const UNKNOWN_MODEL = 'unknown'

/**
 * Claude Code's marker for a message it wrote itself — an interruption notice, an API error
 * line — rather than one the API returned. It is not a model: its usage block is all zeros,
 * and no price list will ever hold a row for it.
 *
 * Left in, it becomes an entry in `model_usage` that pricing cannot resolve, which sets
 * `cost_has_unpriced_models` and makes the UI report "Cost is a floor: no price is held for
 * <synthetic>" on a session whose cost is in fact complete. That warning exists to say real
 * spend is missing from the number; spending it on zero tokens is how it stops being believed.
 */
const SYNTHETIC_MODEL = '<synthetic>'

/** Models that name something other than an API call, and so are never attributed or priced. */
function isRealModel(model: string | undefined): boolean {
  return model !== undefined && model !== SYNTHETIC_MODEL
}

function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  }
}

function readUsage(message: ParsedMessage): RawUsage | undefined {
  return message.metadata?.usage as RawUsage | undefined
}

/**
 * Identity of the API request a message belongs to.
 *
 * Falls back to the message id when the provider gives no requestId, which degrades to
 * the old per-message behaviour rather than collapsing unrelated messages together.
 *
 * Exported because the context processor needs the SAME notion of "one API request" when
 * averaging tokens per turn. Two definitions of a request would drift.
 */
export function requestKey(message: ParsedMessage): string {
  const requestId = message.metadata?.requestId
  return typeof requestId === 'string' && requestId.length > 0 ? requestId : message.id
}

/**
 * Whether a message's usage block is a session aggregate rather than one API request.
 *
 * Copilot CLI writes no per-request usage. Its tokens arrive on `session.shutdown`, which
 * the CLI converts into one meta message per model carrying what that model spent since the
 * previous shutdown. Those messages are each counted once here, which is right for totals
 * and per-model attribution. They are NOT a reading of the context window, nor one turn:
 * taken as either, a single message holding a whole session's spend reported context
 * utilisation in the thousands of percent. The context processor skips them for exactly
 * those two figures.
 */
export function isSessionAggregateUsage(message: ParsedMessage): boolean {
  const providerMetadata = message.metadata?.providerMetadata as Record<string, unknown> | undefined
  return providerMetadata?.copilot_type === 'session.shutdown'
}

function reasoningTokensOf(usage: RawUsage): number {
  return usage.output_tokens_details?.reasoning_tokens ?? usage.reasoning_output_tokens ?? 0
}

function totalsOf(models: ModelTokenUsage[]): TokenTotals {
  return models.reduce((acc, m) => {
    acc.inputTokens += m.inputTokens
    acc.outputTokens += m.outputTokens
    acc.cacheCreationTokens += m.cacheCreationTokens
    acc.cacheReadTokens += m.cacheReadTokens
    acc.reasoningTokens += m.reasoningTokens
    return acc
  }, emptyTotals())
}

function summarise(
  source: TokenAttribution['source'],
  models: ModelTokenUsage[],
  totals: TokenTotals,
  duplicateRequestCount: number
): TokenAttribution {
  const sorted = [...models].sort((a, b) => b.outputTokens - a.outputTokens)
  return {
    source,
    models: sorted,
    totals,
    primaryModel: sorted[0]?.model ?? null,
    distinctModelCount: sorted.length,
    duplicateRequestCount,
  }
}

/**
 * Base model name, with any context-tier suffix stripped.
 *
 * The two sources disagree on naming: a per-message record says `claude-opus-5`, while
 * the summary record for the same requests says `claude-opus-5[1m]`. Joining on the raw
 * string would find nothing and silently drop the TTL split, so the join is on the base
 * name. The suffix itself is preserved everywhere else - it changes the price.
 */
function baseModelName(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '').trim()
}

/**
 * Cache-creation tokens with a 1-hour TTL, per base model, from the messages.
 *
 * Deduplicated on `requestId` for the same reason everything else here is: one response
 * repeats its usage block across several lines.
 */
function observed1hByBaseModel(session: ParsedSession): Map<string, number> {
  const byBase = new Map<string, number>()
  const seenRequests = new Set<string>()

  for (const message of session.messages) {
    const usage = readUsage(message)
    if (!usage?.cache_creation) continue

    const key = requestKey(message)
    if (seenRequests.has(key)) continue
    seenRequests.add(key)

    if (message.metadata?.model === SYNTHETIC_MODEL) continue
    const model =
      typeof message.metadata?.model === 'string' && message.metadata.model.length > 0
        ? baseModelName(message.metadata.model)
        : UNKNOWN_MODEL

    const hours = usage.cache_creation.ephemeral_1h_input_tokens || 0
    if (hours > 0) byBase.set(model, (byBase.get(model) ?? 0) + hours)
  }

  return byBase
}

/**
 * Attach observed 1-hour tokens to models whose totals came from the provider.
 *
 * CAPPED, NEVER EXTRAPOLATED. The observed count is whatever the visible messages show;
 * the authoritative total is the provider's. Where the observed count exceeds the total
 * - a compacted session whose transcript holds more requests than the summary bills -
 * it is clamped, so a model can never be charged the higher rate on more tokens than it
 * wrote. Where it falls short, the shortfall stays at the base cache rate rather than
 * being scaled up: the unseen requests demonstrably have a different TTL mix (measured
 * 30%-99% across real sessions), so scaling would over-charge, and an over-charge is the
 * one error a cost floor must not make.
 *
 * When several priced models share a base name - `claude-opus-5` and `claude-opus-5[1m]`
 * both present - the observed count is allocated between them in proportion to their
 * cache-creation totals. Giving each the full observed figure would bill the same tokens
 * at the higher rate twice.
 */
function applyObserved1hTokens(models: ModelTokenUsage[], observed: Map<string, number>): void {
  if (observed.size === 0) return

  const byBase = new Map<string, ModelTokenUsage[]>()
  for (const model of models) {
    const base = baseModelName(model.model)
    const group = byBase.get(base) ?? []
    group.push(model)
    byBase.set(base, group)
  }

  for (const [base, group] of byBase) {
    const seen = observed.get(base)
    if (!seen) continue

    const groupTotal = group.reduce((n, m) => n + m.cacheCreationTokens, 0)
    if (groupTotal <= 0) continue

    const capped = Math.min(seen, groupTotal)
    for (const model of group) {
      const share = model.cacheCreationTokens / groupTotal
      model.cacheCreation1hTokens = Math.round(capped * share)
    }
  }
}

/**
 * Attribute a session's tokens to models, counting each API request exactly once.
 *
 * Prefers the provider's own summary record when it carries a per-model split, since
 * that is what the provider itself billed against. Falls back to deriving both the split
 * and the totals from per-message usage.
 */
export function attributeTokens(session: ParsedSession): TokenAttribution {
  const providerModels = session.providerTotals?.modelUsage?.filter(m => isRealModel(m.model))
  if (providerModels && providerModels.length > 0) {
    const models: ModelTokenUsage[] = providerModels.map(m => ({
      model: m.model,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheCreationTokens: m.cacheCreationTokens,
      // Filled in below: the summary record carries no TTL breakdown.
      cacheCreation1hTokens: 0,
      cacheReadTokens: m.cacheReadTokens,
      reasoningTokens: 0,
    }))
    applyObserved1hTokens(models, observed1hByBaseModel(session))
    return summarise('provider_totals', models, totalsOf(models), 0)
  }

  const derived = attributeFromMessages(session)

  // Provider gave session totals but no split (Codex). Trust its totals - they are
  // cumulative and authoritative - while keeping the message-derived per-model split.
  const providerTotals = session.providerTotals?.totals
  if (providerTotals) {
    return summarise(
      'mixed',
      derived.models,
      {
        inputTokens: providerTotals.inputTokens,
        outputTokens: providerTotals.outputTokens,
        cacheCreationTokens: providerTotals.cacheCreationTokens,
        cacheReadTokens: providerTotals.cacheReadTokens,
        reasoningTokens: providerTotals.reasoningTokens ?? 0,
      },
      derived.duplicateRequestCount
    )
  }

  return derived
}

/**
 * Derive attribution purely from per-message usage blocks.
 */
function attributeFromMessages(session: ParsedSession): TokenAttribution {
  const byModel = new Map<string, ModelTokenUsage>()
  const totals = emptyTotals()
  const seenRequests = new Set<string>()
  let duplicateRequestCount = 0

  for (const message of session.messages) {
    const usage = readUsage(message)
    if (!usage) continue
    // Not an API call, so it is neither a request to count nor a model to price.
    if (message.metadata?.model === SYNTHETIC_MODEL) continue

    const key = requestKey(message)
    if (seenRequests.has(key)) {
      duplicateRequestCount++
      continue
    }
    seenRequests.add(key)

    const model =
      typeof message.metadata?.model === 'string' && message.metadata.model.length > 0
        ? message.metadata.model
        : UNKNOWN_MODEL

    let entry = byModel.get(model)
    if (!entry) {
      entry = {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 0,
      }
      byModel.set(model, entry)
    }

    const input = usage.input_tokens || 0
    const output = usage.output_tokens || 0
    const cacheCreation = usage.cache_creation_input_tokens || 0
    // Clamped: a malformed record must not report more 1-hour tokens than were written.
    const cacheCreation1h = Math.min(
      usage.cache_creation?.ephemeral_1h_input_tokens || 0,
      cacheCreation
    )
    const cacheRead = usage.cache_read_input_tokens || 0
    const reasoning = reasoningTokensOf(usage)

    entry.inputTokens += input
    entry.outputTokens += output
    entry.cacheCreationTokens += cacheCreation
    entry.cacheCreation1hTokens += cacheCreation1h
    entry.cacheReadTokens += cacheRead
    entry.reasoningTokens += reasoning

    totals.inputTokens += input
    totals.outputTokens += output
    totals.cacheCreationTokens += cacheCreation
    totals.cacheReadTokens += cacheRead
    totals.reasoningTokens += reasoning
  }

  return summarise('message_usage', Array.from(byModel.values()), totals, duplicateRequestCount)
}

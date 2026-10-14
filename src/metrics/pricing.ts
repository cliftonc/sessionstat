/**
 * What a session's tokens would cost at Anthropic's published API rates.
 *
 * This is VALUE, not spend: on a Claude subscription nobody is invoiced for it. Whether it is
 * also spend is decided by the billing mode (see `billing.ts`), never here, and the two are
 * kept as separate figures so that a list-price number can never be summed into a bill.
 *
 * Rates come from the vendored snapshot in `prices.json` (regenerate with
 * `node scripts/update-prices.mjs`). Two rules, both from fest's pricing engine:
 *
 *  1. An unknown model yields null, never an estimate. A plausible guess is worse than an
 *     honest "–", because nobody investigates a number that looks fine.
 *  2. Token buckets are priced separately. Cache reads are ~5% of the input rate and cache
 *     writes 125-200%; folding them together misstates a cache-heavy Claude Code session by
 *     an order of magnitude.
 *
 * Each API request is priced on its own, because a long-context tier applies to the whole
 * request once its context crosses the threshold - an aggregate over the session cannot tell
 * which requests crossed it.
 */

import PRICES from './prices.json' with { type: 'json' }
import { requestKey } from './token-attribution.js'
import type { ParsedSession } from './types.js'

interface TierRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

interface ModelRate extends TierRates {
  tiers: Array<{ aboveTokens: number; rates: TierRates }>
}

const MODELS = PRICES.models as Record<string, ModelRate>

interface RequestUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_1h_input_tokens?: number }
  cache_read_input_tokens?: number
}

/** The rate for a model id, ignoring Claude Code's `[1m]` context tag. Null if unpriced. */
export function lookupRate(model: string | null | undefined): ModelRate | null {
  if (!model) return null
  const id = model.trim().toLowerCase()
  return MODELS[id] ?? MODELS[id.replace(/\[[^\]]*\]$/, '')] ?? null
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** USD for one request at list price. */
export function priceRequest(rate: ModelRate, usage: RequestUsage): number {
  const input = n(usage.input_tokens)
  const cacheRead = n(usage.cache_read_input_tokens)
  const cacheWrite = n(usage.cache_creation_input_tokens)
  const write1h = Math.min(n(usage.cache_creation?.ephemeral_1h_input_tokens), cacheWrite)
  const context = input + cacheRead + cacheWrite

  let t: TierRates = rate
  for (const tier of rate.tiers) if (context > tier.aboveTokens) t = tier.rates

  return (
    (input * t.input +
      cacheRead * t.cacheRead +
      (cacheWrite - write1h) * t.cacheWrite5m +
      write1h * t.cacheWrite1h +
      n(usage.output_tokens) * t.output) /
    1_000_000
  )
}

/**
 * List-price value of every request in the session, each counted once. Null when there are
 * no requests, or when any request used a model with no published rate - a partial sum would
 * read as the whole.
 */
export function sessionValueUsd(session: ParsedSession): number | null {
  const seen = new Set<string>()
  let total = 0
  let requests = 0
  for (const message of session.messages) {
    const usage = message.metadata?.usage as RequestUsage | undefined
    const model = message.metadata?.model as string | undefined
    if (!usage || !model || model === '<synthetic>') continue
    const key = requestKey(message)
    if (seen.has(key)) continue
    seen.add(key)
    const rate = lookupRate(model)
    if (!rate) return null
    total += priceRequest(rate, usage)
    requests++
  }
  return requests > 0 ? total : null
}

#!/usr/bin/env node
/**
 * Regenerate src/metrics/prices.json from litellm's price catalog.
 *
 *   node scripts/update-prices.mjs [path-to-litellm-json]
 *
 * Keeps only Anthropic chat models and the five token buckets sessionstat meters, converted
 * from litellm's per-token floats to USD per million tokens (how Anthropic publishes them).
 * Long-context tiers are discovered from litellm's `_above_<N>k_tokens` key suffixes rather
 * than hardcoded, because the threshold differs between models.
 *
 * The output is a vendored snapshot: sessionstat never fetches prices at runtime.
 */

import { readFile, writeFile } from 'node:fs/promises'

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const OUT = new URL('../src/metrics/prices.json', import.meta.url)
const PER_MILLION = 1_000_000

function perMillion(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? Math.round(v * PER_MILLION * 1e6) / 1e6
    : null
}

/** One tier from a key suffix ('' for base). Null unless input and output are both published. */
function tier(entry, suffix) {
  const input = perMillion(entry[`input_cost_per_token${suffix}`])
  const output = perMillion(entry[`output_cost_per_token${suffix}`])
  if (input === null || output === null) return null
  const write5m = perMillion(entry[`cache_creation_input_token_cost${suffix}`]) ?? input
  return {
    input,
    output,
    cacheRead: perMillion(entry[`cache_read_input_token_cost${suffix}`]) ?? input,
    cacheWrite5m: write5m,
    cacheWrite1h:
      perMillion(
        entry[suffix ? `cache_creation_input_token_cost_above_1hr${suffix}` : 'cache_creation_input_token_cost_above_1hr']
      ) ?? write5m,
  }
}

const raw = process.argv[2]
  ? await readFile(process.argv[2], 'utf-8')
  : await (await fetch(LITELLM_URL)).text()
const catalog = JSON.parse(raw)

const models = {}
for (const [id, entry] of Object.entries(catalog)) {
  if (!entry || typeof entry !== 'object') continue
  if (entry.litellm_provider !== 'anthropic' || entry.mode !== 'chat') continue
  const base = tier(entry, '')
  if (!base) continue

  const thresholds = new Set()
  for (const key of Object.keys(entry)) {
    const match = key.match(/^input_cost_per_token_above_(\d+)k_tokens$/)
    if (match) thresholds.add(Number(match[1]))
  }
  const tiers = [...thresholds]
    .sort((a, b) => a - b)
    .map(k => ({ aboveTokens: k * 1000, rates: tier(entry, `_above_${k}k_tokens`) }))
    .filter(t => t.rates !== null)

  models[id] = { ...base, tiers }
}

const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)))
const out = { source: LITELLM_URL, fetchedAt: new Date().toISOString().slice(0, 10), models: sorted }
await writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`)
console.log(`Wrote ${Object.keys(sorted).length} models to ${OUT.pathname}`)

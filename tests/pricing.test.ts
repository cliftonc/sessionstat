import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeSessionStats, parseTranscript } from '../src/metrics/index.js'
import { lookupRate, priceRequest, sessionValueUsd } from '../src/metrics/pricing.js'
import { FIXTURES } from './helpers.js'

const read = (f: string) => readFileSync(join(FIXTURES, f), 'utf-8')
const withoutCostState = (jsonl: string) =>
  jsonl
    .split('\n')
    .filter(l => !l.includes('"cost-state"'))
    .join('\n')

describe('rate lookup', () => {
  it('finds a model, ignoring the [1m] context tag', () => {
    expect(lookupRate('claude-opus-5-5')).toMatchObject({ input: 4, output: 20 })
    expect(lookupRate('claude-opus-5-5[1m]')).toEqual(lookupRate('claude-opus-5-5'))
  })

  it('never guesses a rate for an unknown model', () => {
    expect(lookupRate('claude-sonnet-4-20250514')).toBeNull()
    expect(lookupRate(null)).toBeNull()
  })
})

describe('pricing one request', () => {
  const rate = {
    input: 1,
    output: 10,
    cacheRead: 0.1,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
    tiers: [
      {
        aboveTokens: 100_000,
        rates: { input: 2, output: 20, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
      },
    ],
  }

  it('prices each bucket at its own rate, splitting 1h cache writes out', () => {
    const usd = priceRequest(rate, {
      input_tokens: 10_000,
      output_tokens: 10_000,
      cache_read_input_tokens: 50_000,
    })
    expect(usd).toBeCloseTo((10_000 * 1 + 10_000 * 10 + 50_000 * 0.1) / 1_000_000)
    expect(
      priceRequest(rate, {
        cache_creation_input_tokens: 40_000,
        cache_creation: { ephemeral_1h_input_tokens: 10_000 },
      })
    ).toBeCloseTo((30_000 * 1.25 + 10_000 * 2) / 1_000_000)
  })

  it('bills the whole request at the long-context tier once context crosses it', () => {
    const usd = priceRequest(rate, { input_tokens: 50_000, cache_read_input_tokens: 60_000 })
    expect(usd).toBeCloseTo((50_000 * 2 + 60_000 * 0.2) / 1_000_000)
  })
})

describe('session value', () => {
  it('prices every request once, before Claude Code writes its cost-state', () => {
    // 8 requests of 10 in, 200 out, 1000 cache write, 5000 cache read at opus-5-5 rates.
    const session = parseTranscript(withoutCostState(read('claude-code-synthetic.jsonl')))
    expect(sessionValueUsd(session)).toBeCloseTo(0.08032, 6)
  })

  it("prefers Claude Code's own figure once it exists", async () => {
    const { stats } = await computeSessionStats(read('claude-code-synthetic.jsonl'))
    expect(stats.valueUsd).toBe(3.4112)
  })

  it('is null when any request used an unpriced model', () => {
    expect(sessionValueUsd(parseTranscript(read('claude-code-sample-2.jsonl')))).toBeNull()
  })
})

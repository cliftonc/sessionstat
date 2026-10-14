import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeSessionStats, isTestCommand, parseTranscript } from '../src/metrics/index.js'
import { FIXTURES } from './helpers.js'

const read = (name: string) => readFileSync(join(FIXTURES, name), 'utf-8')

/**
 * What guidemode's own `ClaudeCodeProcessor.processMetrics` produced for these fixtures, run
 * from guidemode's built `packages/session-processing` on 2026-10-14. The copied processors
 * must agree with it exactly.
 */
const GUIDEMODE = {
  'claude-code-sample-1.jsonl': {
    latency: 3496,
    completion: 772288,
    interruptions: 1,
    successRate: 94,
    iterations: 1,
    processQuality: 50,
    readWriteRatio: 6,
    clarity: 18,
    errorCount: 1,
    primaryModel: 'claude-sonnet-4-20250514',
    tokens: {
      input: 48 + 25,
      output: 521 + 215,
      cacheWrite: 17211 + 19864,
      cacheRead: 172846 + 144201,
    },
  },
  'claude-code-sample-2.jsonl': {
    latency: 3029,
    completion: 91916,
    interruptions: 1,
    successRate: 87,
    iterations: 1,
    processQuality: 60,
    readWriteRatio: 2.5,
    clarity: 3,
    errorCount: 2,
    primaryModel: 'claude-sonnet-4-20250514',
    tokens: { input: 1102, output: 445, cacheWrite: 12732, cacheRead: 300013 },
  },
  'claude-code-synthetic.jsonl': {
    latency: 10000,
    completion: 136000,
    interruptions: 1,
    successRate: 86,
    iterations: 1,
    processQuality: 50,
    readWriteRatio: 0.33,
    clarity: 27,
    errorCount: 1,
    primaryModel: 'claude-opus-5-5',
    tokens: { input: 1200, output: 45000, cacheWrite: 80000, cacheRead: 1200000 },
  },
} as const

describe('metrics match guidemode for the same fixture', () => {
  for (const [fixture, expected] of Object.entries(GUIDEMODE)) {
    it(fixture, async () => {
      const { stats, raw } = await computeSessionStats(read(fixture))
      expect(raw.performance?.response_latency_ms).toBe(expected.latency)
      expect(raw.performance?.task_completion_time_ms).toBe(expected.completion)
      expect(raw.engagement?.total_interruptions).toBe(expected.interruptions)
      expect(raw.quality?.task_success_rate).toBe(expected.successRate)
      expect(raw.quality?.iteration_count).toBe(expected.iterations)
      expect(raw.quality?.process_quality_score).toBe(expected.processQuality)
      expect(raw.usage?.read_write_ratio).toBe(expected.readWriteRatio)
      expect(raw.usage?.input_clarity_score).toBe(expected.clarity)
      expect(raw.error?.error_count).toBe(expected.errorCount)
      expect(raw['token-cost']?.primary_model).toBe(expected.primaryModel)

      expect(stats.model).toBe(expected.primaryModel)
      expect(stats.tokens).toEqual(expected.tokens)
      expect(stats.durationMs).toBe(expected.completion)
      expect(stats.interruptions).toBe(expected.interruptions)
      expect(stats.successRate).toBe(expected.successRate)
    })
  }
})

describe('the counts the comment adds', () => {
  it('reads the synthetic session exactly', async () => {
    const { stats } = await computeSessionStats(read('claude-code-synthetic.jsonl'))
    expect(stats).toMatchObject({
      sessionId: 'synthetic-session-0001',
      turns: 2,
      toolCalls: 7,
      filesEdited: ['/tmp/example-repo/src/login.ts', '/tmp/example-repo/tests/login.test.ts'],
      valueUsd: 3.4112,
      errors: 1,
      toolResults: 7,
      compactions: 1,
      testRuns: { passed: 1, failed: 1 },
      linesAdded: 42,
      linesRemoved: 3,
    })
    expect(stats.tools).toEqual([
      { name: 'Bash', count: 3 },
      { name: 'Edit', count: 2 },
      { name: 'Read', count: 1 },
      { name: 'Write', count: 1 },
    ])
  })

  it('has no value for a model with no published rate', async () => {
    const { stats } = await computeSessionStats(read('claude-code-sample-1.jsonl'))
    expect(stats.valueUsd).toBeNull()
    expect(stats.compactions).toBe(0)
  })

  it('skips summary lines, as guidemode does', () => {
    const session = parseTranscript(read('claude-code-with-summary.jsonl'))
    expect(session.sessionId).toBe('test-session-123')
    expect(session.messages).toHaveLength(2)
  })

  it('recognises test commands and nothing else', () => {
    for (const cmd of [
      'pnpm test',
      'npm run test:unit',
      'npx vitest run',
      'cd a && go test ./...',
      'pytest -q',
      'cargo test',
    ]) {
      expect(isTestCommand(cmd), cmd).toBe(true)
    }
    for (const cmd of ['git push', 'cat test.txt', 'ls tests', 'echo latest', 'pnpm build']) {
      expect(isTestCommand(cmd), cmd).toBe(false)
    }
  })
})

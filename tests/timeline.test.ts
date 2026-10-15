import { describe, expect, it } from 'vitest'
import { buildTimeline } from '../src/template/timeline.js'
import { formatModel, formatShortTime } from '../src/template/view.js'

const MIN = 60_000
const at = (iso: string) => new Date(iso).getTime()
const span = (iso: string, minutes: number) => ({ start: at(iso), end: at(iso) + minutes * MIN })
/** The bar as GitHub shows it: the escaped break unescaped. */
const shown = (bar: string) => bar.replace(/\\\|/g, '|')

describe('buildTimeline', () => {
  it('lays sessions out on real time, every bar the same width', () => {
    const t = buildTimeline([span('2026-10-14T09:00Z', 60), span('2026-10-14T11:00Z', 60)], {
      width: 12,
    })
    expect(t.bars.map(shown)).toEqual(['████········', '········████'])
    expect(t.breaks).toBe(0)
    expect(t.msPerChar).toBe(15 * MIN)
  })

  it('cuts idle time longer than the limit down to a || break', () => {
    const t = buildTimeline([span('2026-10-14T09:00Z', 60), span('2026-10-15T09:00Z', 60)], {
      width: 12,
    })
    expect(t.breaks).toBe(1)
    expect(t.bars.map(shown)).toEqual(['█████||·····', '·····||█████'])
    // Escaped, so the pipes do not end the markdown table cell.
    expect(t.bars[0]).toContain('\\|\\|')
  })

  it('keeps gaps shorter than the limit at true scale', () => {
    const t = buildTimeline([span('2026-10-14T09:00Z', 30), span('2026-10-14T12:00Z', 30)], {
      width: 16,
      maxGapMs: 4 * 60 * MIN,
    })
    expect(t.breaks).toBe(0)
    // 30 minutes at about 13 minutes a character: two and a half characters.
    expect(t.bars.map(shown)).toEqual(['██▌·············', '·············▐██'])
  })

  it('gives a very short session at least half a character', () => {
    const t = buildTimeline([span('2026-10-14T09:00Z', 120), span('2026-10-14T11:00Z', 0.5)], {
      width: 8,
    })
    expect(shown(t.bars[1])).toMatch(/[▌▐█]$/)
  })

  it('never counts overlapping sessions as idle', () => {
    const t = buildTimeline([
      span('2026-10-14T09:00Z', 600),
      span('2026-10-14T10:00Z', 30),
      span('2026-10-14T18:00Z', 60),
    ])
    expect(t.breaks).toBe(0)
  })

  it('handles no sessions, and a session with no duration', () => {
    expect(buildTimeline([]).bars).toEqual([])
    const [bar] = buildTimeline([span('2026-10-14T09:00Z', 0)], { width: 4 }).bars
    expect(shown(bar)).toBe('▌···')
  })
})

describe('formatModel', () => {
  it.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
    ['claude-haiku-5-5', 'Haiku 5.5'],
    ['claude-3-5-sonnet-20241022', 'Sonnet 3.5'],
    ['gpt-5', 'gpt-5'],
    [null, 'unknown'],
  ])('%s → %s', (model, name) => {
    expect(formatModel(model)).toBe(name)
  })
})

describe('formatShortTime', () => {
  it('is UTC, month name, day and minutes', () => {
    expect(formatShortTime('2026-10-04T09:05:59Z')).toBe('Oct 04 09:05')
  })
})

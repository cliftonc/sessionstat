/**
 * A text Gantt row per session, for a markdown table cell: real time from the first session's
 * start to the last one's end, with any idle stretch longer than `maxGapMs` cut down to a fixed
 * `||` break, so a PR worked over several days still has readable bars. Half-character blocks
 * (`▐` `█` `▌`) place each bar to within half a character; every session gets at least half.
 *
 * The `|` of a break would end the table cell, so it is written escaped (`\|`); GitHub shows it
 * as a plain `|`, inside code too.
 */

export interface TimelineSpan {
  start: number
  end: number
}

export interface TimelineOptions {
  /** Characters per bar. */
  width?: number
  /** Idle time longer than this is cut. */
  maxGapMs?: number
  /** Characters a cut takes. */
  breakWidth?: number
}

export interface Timeline {
  /** One bar per span, in the order given. */
  bars: string[]
  /** Real time per character, after the cuts. */
  msPerChar: number
  /** Number of cuts drawn. */
  breaks: number
  from: number
  to: number
}

export const MAX_GAP_HOURS = 4

const TRACK = '·'
const BREAK = '\\|'

export function buildTimeline(spans: TimelineSpan[], options: TimelineOptions = {}): Timeline {
  const width = options.width ?? 24
  const maxGap = options.maxGapMs ?? MAX_GAP_HOURS * 60 * 60_000
  const breakWidth = options.breakWidth ?? 2
  if (spans.length === 0) return { bars: [], msPerChar: 0, breaks: 0, from: 0, to: 0 }

  const from = Math.min(...spans.map(s => s.start))
  const to = Math.max(...spans.map(s => Math.max(s.end, s.start)))

  // Idle stretches: walk the spans in time order, tracking the latest end so far, so
  // overlapping sessions never count as idle.
  const cuts: Array<{ start: number; end: number }> = []
  let reach = from
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start - reach > maxGap) cuts.push({ start: reach, end: s.start })
    reach = Math.max(reach, s.end)
  }

  const kept = to - from - cuts.reduce((n, c) => n + (c.end - c.start), 0)
  const halves = Math.max(2, (width - breakWidth * cuts.length) * 2)
  const msPerHalf = kept > 0 ? kept / halves : 1

  /** Position in half-characters, with each cut drawn as `breakWidth` characters. */
  const at = (t: number): number => {
    let pos = 0
    let prev = from
    for (const cut of cuts) {
      if (t <= cut.start) break
      pos += (cut.start - prev) / msPerHalf + breakWidth * 2
      prev = cut.end
      if (t < cut.end) return pos
    }
    return pos + (t - prev) / msPerHalf
  }

  const breakChars = new Set<number>()
  for (const cut of cuts) {
    const first = Math.round(at(cut.start) / 2)
    for (let k = 0; k < breakWidth; k++) breakChars.add(first + k)
  }

  const bars = spans.map(span => {
    const startHalf = Math.min(width * 2 - 1, Math.floor(at(span.start)))
    const endHalf = Math.min(width * 2, Math.max(startHalf + 1, Math.round(at(span.end))))
    let bar = ''
    for (let c = 0; c < width; c++) {
      const left = 2 * c >= startHalf && 2 * c < endHalf
      const right = 2 * c + 1 >= startHalf && 2 * c + 1 < endHalf
      if (left && right) bar += '█'
      else if (left) bar += '▌'
      else if (right) bar += '▐'
      else bar += breakChars.has(c) ? BREAK : TRACK
    }
    return bar
  })

  return { bars, msPerChar: msPerHalf * 2, breaks: cuts.length, from, to }
}

/**
 * Unified Engagement Metrics Processor
 *
 * Works for all providers using the canonical format.
 * Measures interruption rate and session length.
 */

import { hasInterruptionMarker, isHumanPrompt, isSidechain } from './message-filters.js'
import { BaseMetricProcessor } from './metric-processor.js'
import type { EngagementMetrics } from './types.js'
import type { ParsedMessage, ParsedSession } from './types.js'

export class CanonicalEngagementProcessor extends BaseMetricProcessor {
  readonly name = 'canonical-engagement'
  readonly metricType = 'engagement' as const
  readonly description = 'Measures interruption rate and session length (unified for all providers)'

  async process(session: ParsedSession): Promise<EngagementMetrics> {
    const humanPrompts = session.messages.filter(isHumanPrompt)
    const interruptions = this.findInterruptions(session.messages)

    // Every input the person actually made. Interruptions MUST be included: the parser
    // gives them their own message type, so they are absent from `humanPrompts`, and
    // dividing by prompts alone can exceed 100% - a real session measured 4 interruptions
    // against 3 prompts, reporting 133%.
    const totalHumanInputs = humanPrompts.length + interruptions.length

    if (totalHumanInputs === 0) {
      return {
        interruption_rate: 0,
        total_interruptions: 0,
        session_length_minutes: 0,
      }
    }

    const interruptionRate = Math.round((interruptions.length / totalHumanInputs) * 100)

    // Calculate session length in minutes
    const sessionLengthMinutes = Math.round(session.duration / (1000 * 60))

    return {
      interruption_rate: interruptionRate,
      total_interruptions: interruptions.length,
      session_length_minutes: sessionLengthMinutes,
      metadata: {
        total_responses: totalHumanInputs,
        improvement_tips: this.generateImprovementTips(interruptionRate, sessionLengthMinutes),
      },
    }
  }

  /**
   * Interruptions the person actually made.
   *
   * ONLY the explicit ESC marker counts. This used to also treat consecutive user
   * messages, and any message containing the substrings "wait", "stop", "actually" or
   * "cancel", as interruptions. Measured over 36 real sessions those two rules produced
   * 179 detections against 46 genuine ones - a 4.9x over-count - because they fire on
   * ordinary prose like "I'll wait for the agents" or "the stop_reason field".
   *
   * Adjacent markers collapse to one. A single ESC during a tool call can emit both the
   * `for tool use` marker in the tool_result AND a text marker on the following message;
   * counting them separately would double every interruption that lands mid-tool.
   */
  private findInterruptions(messages: ParsedMessage[]): ParsedMessage[] {
    const interruptions: ParsedMessage[] = []
    let previousWasToolResultMarker = false

    for (const message of messages) {
      if (isSidechain(message)) continue

      const isInterruption = message.type === 'interruption' || hasInterruptionMarker(message)

      if (isInterruption) {
        // Collapse only the specific double-emission: the aborted tool's result carries
        // `for tool use`, and the very next message repeats the plain marker. Deliberately
        // narrow - a blunt "ignore any adjacent marker" rule would also swallow two
        // genuine ESC presses in a row.
        if (!previousWasToolResultMarker) {
          interruptions.push(message)
        }
        previousWasToolResultMarker = message.type === 'tool_result'
      } else {
        previousWasToolResultMarker = false
      }
    }

    return interruptions
  }

  /**
   * Generate improvement tips based on metrics
   */
  private generateImprovementTips(interruptionRate: number, sessionLength: number): string[] {
    const tips: string[] = []

    if (interruptionRate > 50) {
      tips.push('High interruption rate - consider providing more context upfront')
      tips.push('Note: Some interruptions are effective when steering AI back on track')
    }

    if (sessionLength > 60) {
      tips.push("Long session - ensure you're making steady progress on your task")
      tips.push('Consider whether initial requirements were comprehensive enough')
    }

    if (interruptionRate < 10 && sessionLength < 30) {
      tips.push('Excellent collaboration! Efficient session with minimal course corrections')
    }

    return tips
  }
}

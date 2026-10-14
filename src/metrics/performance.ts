/**
 * Unified Performance Metrics Processor
 *
 * Works for all providers using the canonical format.
 * Measures response latency and task completion time.
 */

import { BaseMetricProcessor } from './metric-processor.js'
import type { PerformanceMetrics } from './types.js'
import type { ParsedSession } from './types.js'

export class CanonicalPerformanceProcessor extends BaseMetricProcessor {
  readonly name = 'canonical-performance'
  readonly metricType = 'performance' as const
  readonly description =
    'Measures response latency and task completion time (unified for all providers)'

  async process(session: ParsedSession): Promise<PerformanceMetrics> {
    const messages = session.messages

    if (messages.length === 0) {
      return {
        response_latency_ms: 0,
        task_completion_time_ms: 0,
      }
    }

    // Calculate response latency
    const responseTimes = this.calculateResponseTimes(session)
    const averageResponseTime =
      responseTimes.length > 0
        ? responseTimes.reduce((sum, rt) => sum + rt, 0) / responseTimes.length
        : 0

    // Task completion time is total session duration
    const taskCompletionTime = session.duration

    return {
      response_latency_ms: Math.round(averageResponseTime),
      task_completion_time_ms: taskCompletionTime,
      metadata: {
        total_responses: responseTimes.length,
        improvement_tips: this.generateImprovementTips(averageResponseTime, taskCompletionTime),
      },
    }
  }

  /**
   * Calculate response times between user messages and assistant responses
   */
  private calculateResponseTimes(session: ParsedSession): number[] {
    const responseTimes: number[] = []

    for (let i = 0; i < session.messages.length - 1; i++) {
      const current = session.messages[i]
      const next = session.messages[i + 1]

      if (current.type === 'user' && next.type === 'assistant') {
        const responseTime = next.timestamp.getTime() - current.timestamp.getTime()
        responseTimes.push(responseTime)
      }
    }

    return responseTimes
  }

  /**
   * Generate improvement tips
   */
  private generateImprovementTips(responseLatency: number, completionTime: number): string[] {
    const tips: string[] = []

    if (responseLatency > 10000) {
      tips.push('Consider breaking complex requests into smaller, more specific tasks')
      tips.push('Provide more context upfront to reduce AI thinking time')
    }

    if (completionTime > 1800000) {
      tips.push('Try to be more specific in your initial request to reduce back-and-forth')
      tips.push('Consider providing code examples or file paths to speed up the process')
    }

    return tips
  }
}

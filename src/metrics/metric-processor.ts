import type { MetricType, SessionMetricsData } from './types.js'
import { isStructuredMessageContent } from './types.js'
import type { ParsedSession, ProcessorResult } from './types.js'

export abstract class BaseMetricProcessor {
  abstract readonly name: string
  abstract readonly metricType: MetricType
  abstract readonly description: string

  /**
   * Process a parsed session and extract specific metrics
   * This method should be async to support AI calls and other async operations
   */
  abstract process(session: ParsedSession): Promise<SessionMetricsData>

  /**
   * Check if this processor can handle the given session
   * Default implementation checks if the provider is supported
   */
  canProcess(_session: ParsedSession): boolean {
    return true
  }

  /**
   * Validate that the session contains required data for this processor
   */
  protected validateSession(session: ParsedSession): void {
    if (!session.sessionId) {
      throw new Error('Session ID is required')
    }
    if (!session.messages || session.messages.length === 0) {
      throw new Error('Session must contain messages')
    }
  }

  /**
   * Public method to process a session and create a result with timing information
   */
  async processToResult(session: ParsedSession): Promise<ProcessorResult> {
    return this.createResult(session)
  }

  /**
   * Create a processor result with timing information
   */
  protected async createResult(session: ParsedSession): Promise<ProcessorResult> {
    const startTime = Date.now()

    try {
      this.validateSession(session)
      const metrics = await this.process(session)
      const processingTime = Date.now() - startTime

      return {
        metricType: this.metricType,
        metrics,
        processingTime,
        metadata: {
          processor: this.name,
          processingTime,
          messageCount: session.messages.length,
          sessionDuration: session.duration,
        },
      }
    } catch (error) {
      const processingTime = Date.now() - startTime
      throw new Error(
        `${this.name} processor failed: ${error instanceof Error ? error.message : 'Unknown error'} (processing time: ${processingTime}ms)`
      )
    }
  }

  /**
   * Helper method to find messages by type
   */
  protected findMessagesByType(
    session: ParsedSession,
    type: string | string[]
  ): ParsedSession['messages'] {
    const types = Array.isArray(type) ? type : [type]
    return session.messages.filter(msg => types.includes(msg.type))
  }

  /**
   * Helper method to calculate time differences between messages
   */
  protected calculateTimeDifference(startTime: Date, endTime: Date): number {
    return endTime.getTime() - startTime.getTime()
  }

  /**
   * Helper method to extract content from messages safely
   */
  protected extractContent(message: ParsedSession['messages'][0]): string {
    if (typeof message.content === 'string') {
      return message.content
    }
    if (isStructuredMessageContent(message.content)) {
      return message.content.text || ''
    }
    return JSON.stringify(message.content || '')
  }
}

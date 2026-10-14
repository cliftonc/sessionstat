/**
 * Unified Error Metrics Processor
 *
 * Works for all providers using the canonical format.
 * Tracks errors, failures, and recovery patterns.
 */

import { BaseMetricProcessor } from './metric-processor.js'
import type { ErrorMetrics, ToolResultContent } from './types.js'
import { isStructuredMessageContent } from './types.js'
import type { ParsedSession } from './types.js'

export class CanonicalErrorProcessor extends BaseMetricProcessor {
  readonly name = 'canonical-error'
  readonly metricType = 'error' as const
  readonly description =
    'Tracks errors, failures, and recovery patterns (unified for all providers)'

  async process(session: ParsedSession): Promise<ErrorMetrics> {
    const toolResults = this.extractToolResults(session)

    if (toolResults.length === 0) {
      return {
        error_count: 0,
        error_types: [],
        last_error_message: '',
        recovery_attempts: 0,
        fatal_errors: 0,
      }
    }

    // Extract errors from tool results
    const errors = this.extractErrors(toolResults)
    const errorTypes = this.categorizeErrors(errors)
    const recoveryAttempts = this.countRecoveryAttempts(session)
    const fatalErrors = errors.filter(e => e.severity === 'fatal').length

    return {
      error_count: errors.length,
      error_types: Array.from(new Set(errorTypes)),
      last_error_message: '', // Kept for backwards compatibility, not displayed
      recovery_attempts: recoveryAttempts,
      fatal_errors: fatalErrors,
      metadata: {
        improvement_tips: this.generateImprovementTips(errors.length, fatalErrors),
      },
    }
  }

  /**
   * Extract tool results from session
   */
  private extractToolResults(session: ParsedSession): ToolResultContent[] {
    const toolResults: ToolResultContent[] = []

    for (const message of session.messages) {
      if (isStructuredMessageContent(message.content) && message.content.toolResult) {
        toolResults.push(message.content.toolResult)
      }
    }

    return toolResults
  }

  /**
   * Extract errors from tool results
   */
  private extractErrors(
    toolResults: ToolResultContent[]
  ): Array<{ message: string; severity: 'warning' | 'error' | 'fatal' }> {
    const errors: Array<{ message: string; severity: 'warning' | 'error' | 'fatal' }> = []

    for (const result of toolResults) {
      // Check explicit error flag
      if (result.is_error) {
        const message =
          typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
        const severity = this.determineSeverity(message)
        errors.push({ message, severity })
        continue
      }

      // Check content for error indicators
      const content =
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
      const contentLower = content.toLowerCase()

      if (this.hasErrorIndicators(contentLower)) {
        const severity = this.determineSeverity(contentLower)
        errors.push({ message: content.substring(0, 200), severity })
      }
    }

    return errors
  }

  /**
   * Check if content has error indicators
   */
  private hasErrorIndicators(content: string): boolean {
    const errorKeywords = [
      'error:',
      'exception',
      'failed',
      'failure',
      'permission denied',
      'access denied',
      'not found',
      'does not exist',
      'invalid',
      'cannot',
      'unable to',
      'could not',
    ]

    return errorKeywords.some(keyword => content.includes(keyword))
  }

  /**
   * Determine error severity
   */
  private determineSeverity(message: string): 'warning' | 'error' | 'fatal' {
    const messageLower = message.toLowerCase()

    const fatalKeywords = [
      'fatal error',
      'critical error',
      'cannot continue',
      'system failure',
      'unrecoverable',
    ]

    const warningKeywords = ['warning:', 'deprecated', 'caution', 'notice']

    if (fatalKeywords.some(keyword => messageLower.includes(keyword))) {
      return 'fatal'
    }

    if (warningKeywords.some(keyword => messageLower.includes(keyword))) {
      return 'warning'
    }

    return 'error'
  }

  /**
   * Categorize errors by type
   */
  private categorizeErrors(errors: Array<{ message: string; severity: string }>): string[] {
    const categories = new Set<string>()

    for (const error of errors) {
      const message = error.message.toLowerCase()

      // File system errors
      if (message.includes('not found') || message.includes('does not exist')) {
        categories.add('file_not_found')
      } else if (message.includes('permission denied') || message.includes('access denied')) {
        categories.add('permission_error')
      } else if (
        message.includes('file') &&
        (message.includes('error') || message.includes('failed'))
      ) {
        categories.add('file_operation_error')
      }
      // Code/syntax errors
      else if (message.includes('syntax error') || message.includes('parse error')) {
        categories.add('syntax_error')
      } else if (message.includes('type error') || message.includes('undefined')) {
        categories.add('type_error')
      }
      // Runtime errors
      else if (message.includes('timeout') || message.includes('timed out')) {
        categories.add('timeout_error')
      } else if (message.includes('connection') && message.includes('failed')) {
        categories.add('connection_error')
      }
      // Generic
      else {
        categories.add('general_error')
      }
    }

    return Array.from(categories)
  }

  /**
   * Count recovery attempts (retries after errors)
   */
  private countRecoveryAttempts(session: ParsedSession): number {
    let recoveryAttempts = 0

    for (let i = 0; i < session.messages.length - 1; i++) {
      const current = session.messages[i]
      const next = session.messages[i + 1]

      // If assistant message has error in tool result, and next is user or assistant retry
      if (current.type === 'assistant' && (next.type === 'user' || next.type === 'assistant')) {
        const content = this.extractTextContent(current).toLowerCase()
        if (this.hasErrorIndicators(content)) {
          recoveryAttempts++
        }
      }
    }

    return recoveryAttempts
  }

  /**
   * Extract text content from message
   */
  private extractTextContent(message: { content: string | { text?: string } }): string {
    if (typeof message.content === 'string') {
      return message.content
    }

    if (message.content.text) {
      return message.content.text
    }

    return ''
  }

  /**
   * Generate improvement tips
   */
  private generateImprovementTips(errorCount: number, fatalErrors: number): string[] {
    const tips: string[] = []

    if (errorCount > 5) {
      tips.push('High error rate - consider providing more context or breaking down the task')
    }

    if (fatalErrors > 0) {
      tips.push('Fatal errors detected - review error messages and address root causes')
    }

    return tips
  }
}

/**
 * Base Parser - Abstract base class for all provider-specific parsers
 *
 * Provides common parsing logic, validation, and utilities that all providers can use.
 * Each provider extends this and implements provider-specific transformation logic.
 */

import type {
  ContentPart,
  ParsedMessage,
  ParsedSession,
  RawLogMessage,
  SessionParser,
} from './types.js'

export abstract class BaseParser implements SessionParser {
  abstract readonly name: string
  abstract readonly providerName: string

  /**
   * Parse JSONL content into a structured session
   * Template method that handles common logic
   */
  parseSession(jsonlContent: string): ParsedSession {
    this.validateContent(jsonlContent)

    const lines = jsonlContent.split('\n').filter(line => line.trim())
    const messages: ParsedMessage[] = []
    let sessionId = ''
    let startTime: Date | null = null
    let endTime: Date | null = null

    for (let i = 0; i < lines.length; i++) {
      try {
        const rawMessage = JSON.parse(lines[i]) as RawLogMessage

        // Extract session ID from first valid message
        if (!sessionId) {
          sessionId = this.extractSessionId(rawMessage) || ''
        }

        // Skip messages without timestamps
        if (!rawMessage.timestamp) {
          continue
        }

        const timestamp = new Date(rawMessage.timestamp)
        if (Number.isNaN(timestamp.getTime())) {
          continue
        }

        // Track session time boundaries
        if (!startTime || timestamp < startTime) {
          startTime = timestamp
        }
        if (!endTime || timestamp > endTime) {
          endTime = timestamp
        }

        // Parse message (may return multiple messages)
        const parsedMessages = this.parseMessage(rawMessage)
        messages.push(...parsedMessages)
      } catch (_error) {}
    }

    // Set defaults if not found
    if (!sessionId) {
      sessionId = `session_${Date.now()}`
    }
    if (!startTime) {
      startTime = new Date()
    }
    if (!endTime) {
      endTime = startTime
    }

    const duration = endTime.getTime() - startTime.getTime()

    return {
      sessionId,
      provider: this.providerName,
      messages,
      startTime,
      endTime,
      duration,
      metadata: {
        messageCount: messages.length,
        lineCount: lines.length,
      },
    }
  }

  /**
   * Parse a single raw message - must be implemented by each provider
   */
  abstract parseMessage(rawMessage: RawLogMessage): ParsedMessage[]

  /**
   * Check if content can be parsed - must be implemented by each provider
   */
  abstract canParse(jsonlContent: string): boolean

  /**
   * Extract session ID from a raw message
   * Can be overridden by providers if they store sessionId differently
   */
  protected extractSessionId(rawMessage: RawLogMessage): string | null {
    if (typeof rawMessage.sessionId === 'string') {
      return rawMessage.sessionId
    }
    if (typeof rawMessage.sessionID === 'string') {
      return rawMessage.sessionID
    }
    return null
  }

  /**
   * Validate JSONL content format
   */
  protected validateContent(content: string): void {
    if (!content || content.trim().length === 0) {
      throw new Error('Content is empty')
    }

    const lines = content.split('\n').filter(line => line.trim())
    if (lines.length === 0) {
      throw new Error('No valid lines found in content')
    }

    // Validate first few lines as JSON
    const linesToCheck = Math.min(3, lines.length)
    for (let i = 0; i < linesToCheck; i++) {
      try {
        JSON.parse(lines[i])
      } catch (_error) {
        throw new Error(`Invalid JSON on line ${i + 1}`)
      }
    }
  }

  /**
   * Parse parts structure from content
   * Common pattern across providers
   */
  protected parsePartsContent(content: unknown): { parts: ContentPart[] } | null {
    try {
      // Handle string content that might be JSON
      if (typeof content === 'string') {
        const parsed = JSON.parse(content)
        if (parsed?.parts && Array.isArray(parsed.parts)) {
          return parsed
        }
      }

      // Handle object with parts array
      if (
        content &&
        typeof content === 'object' &&
        'parts' in content &&
        Array.isArray((content as { parts: unknown }).parts)
      ) {
        return content as { parts: ContentPart[] }
      }
    } catch (_error) {
      // Not valid JSON or not a parts structure
    }

    return null
  }

  /**
   * Extract text from parts structure
   * Common utility used by many providers
   */
  protected extractTextFromParts(parts: ContentPart[]): string {
    return parts
      .filter(part => part.type === 'text' && part.text)
      .map(part => part.text)
      .join('\n')
  }

  /**
   * Check if content contains interruption markers
   */
  protected isInterruptionContent(content: unknown): boolean {
    const text = this.extractTextContent(content)
    return (
      text.includes('[Request interrupted by user]') || text.includes('Request interrupted by user')
    )
  }

  /**
   * Check if content contains command markers
   */
  protected isCommandContent(content: unknown): boolean {
    const text = this.extractTextContent(content)
    return text.startsWith('/') || text.includes('<command-name>')
  }

  /**
   * Extract text content from any content type
   * Handles strings, parts arrays, and nested structures
   */
  protected extractTextContent(content: unknown): string {
    if (typeof content === 'string') {
      return content
    }

    if (Array.isArray(content)) {
      const textParts = content
        .filter(
          (part): part is ContentPart =>
            typeof part === 'object' && part !== null && part.type === 'text'
        )
        .map(part => part.text || '')
      return textParts.join(' ')
    }

    const partsContent = this.parsePartsContent(content)
    if (partsContent) {
      return this.extractTextFromParts(partsContent.parts)
    }

    return ''
  }

  /**
   * Generate a unique message ID
   */
  protected generateMessageId(index: number, timestamp?: Date): string {
    const time = timestamp ? timestamp.getTime() : Date.now()
    return `msg_${time}_${index}`
  }

  /**
   * Parse timestamp string to Date
   */
  protected parseTimestamp(timestampStr: string | undefined): Date | null {
    if (!timestampStr) return null

    try {
      const date = new Date(timestampStr)
      if (Number.isNaN(date.getTime())) {
        return null
      }
      return date
    } catch (_error) {
      return null
    }
  }
}

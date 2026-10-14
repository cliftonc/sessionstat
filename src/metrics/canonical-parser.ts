/**
 * Canonical Parser
 *
 * Copied from guidemode `packages/session-processing/src/parsers/canonical/parser.ts`.
 * Claude Code's native JSONL IS the canonical format (guidemode uploads it unconverted and
 * the server runs this parser on it), so no conversion step is needed here.
 *
 * Universal parser for canonical JSONL format used by all providers.
 * This eliminates the need for provider-specific parsers - all providers
 * write canonical JSONL, and this single parser handles all of them.
 */

import { BaseParser } from './base-parser.js'
import type { CanonicalContentBlock, CanonicalMessage } from './canonical-types.js'
import type { StructuredMessageContent, ToolResultContent, ToolUseContent } from './types.js'
import type { ParsedMessage, RawLogMessage, UnifiedMessageType } from './types.js'

export class CanonicalParser extends BaseParser {
  readonly name = 'canonical'
  readonly providerName = 'canonical'

  /**
   * Check if this parser can handle the given JSONL content
   * Canonical format has uuid, sessionId, and message.role fields
   */
  canParse(jsonlContent: string): boolean {
    try {
      this.validateContent(jsonlContent)

      const lines = jsonlContent.split('\n').filter(line => line.trim())
      if (lines.length === 0) return false

      // Check first valid message for canonical markers
      for (const line of lines.slice(0, 5)) {
        try {
          const message = JSON.parse(line) as Partial<CanonicalMessage>

          // Canonical format has these key fields
          if (
            message.uuid &&
            message.sessionId &&
            message.message?.role &&
            message.type &&
            ['user', 'assistant', 'meta'].includes(message.type)
          ) {
            return true
          }
        } catch {}
      }

      return false
    } catch {
      return false
    }
  }

  /**
   * Parse a single canonical message into one or more ParsedMessages
   * Handles both text content and structured content (with tool blocks)
   */
  parseMessage(rawMessage: RawLogMessage): ParsedMessage[] {
    const canonical = rawMessage as unknown as CanonicalMessage

    // Validate required fields
    if (!canonical.uuid || !canonical.timestamp || !canonical.type || !canonical.message) {
      return []
    }

    const timestamp = this.parseTimestamp(canonical.timestamp)
    if (!timestamp) {
      return []
    }

    // Skip empty command stdout messages (Claude Code specific)
    // These are user messages with content like "<local-command-stdout></local-command-stdout>"
    if (typeof canonical.message.content === 'string') {
      const content = canonical.message.content.trim()
      if (content === '<local-command-stdout></local-command-stdout>') {
        return []
      }
    }

    // Handle text content (simple case)
    if (typeof canonical.message.content === 'string') {
      return [this.parseTextMessage(canonical, timestamp)]
    }

    // Handle structured content (text + tools)
    if (Array.isArray(canonical.message.content)) {
      return this.parseStructuredMessage(canonical, timestamp)
    }

    // Fallback to empty string for unknown content types
    return [this.parseTextMessage(canonical, timestamp)]
  }

  /**
   * Parse canonical message with text content
   */
  private parseTextMessage(canonical: CanonicalMessage, timestamp: Date): ParsedMessage {
    const content = typeof canonical.message.content === 'string' ? canonical.message.content : ''

    // Determine actual message type by inspecting content
    const messageType = this.determineMessageType(canonical, content)

    return {
      id: canonical.uuid,
      timestamp,
      type: messageType, // Now uses intelligent type detection
      content,
      metadata: {
        role: canonical.message.role,
        sessionId: canonical.sessionId,
        provider: canonical.provider,
        cwd: canonical.cwd,
        gitBranch: canonical.gitBranch,
        version: canonical.version,
        model: canonical.message.model,
        usage: canonical.message.usage,
        providerMetadata: canonical.providerMetadata, // Preserve provider-specific data
        requestId: canonical.requestId,
        isMeta: canonical.isMeta,
        isSidechain: canonical.isSidechain,
        userType: canonical.userType,
      },
      parentId: canonical.parentUuid,
    }
  }

  /**
   * Parse canonical message with structured content blocks
   *
   * NOTE: Messages can contain multiple blocks of different types:
   * - Claude Code/Cursor: text/thinking + tool_use in one message
   * - Gemini: multiple thinking blocks in one message
   *
   * When a message has BOTH text and tool blocks, we split into multiple parsed messages.
   */
  private parseStructuredMessage(canonical: CanonicalMessage, timestamp: Date): ParsedMessage[] {
    const blocks = canonical.message.content as CanonicalContentBlock[]

    if (blocks.length === 0) {
      return []
    }

    // Special case: Multiple thinking blocks only (Gemini extended thinking)
    // Create a separate message for each thinking block
    if (blocks.length > 1 && blocks.every(b => b.type === 'thinking')) {
      return blocks
        .map((block, index) => this.createThinkingMessage(canonical, block, timestamp, index))
        .filter((msg): msg is ParsedMessage => msg !== null)
    }

    // Extract all block types from the message
    const textBlocks = blocks.filter(b => b.type === 'text' || b.type === 'thinking')
    const toolUseBlock = blocks.find(b => b.type === 'tool_use')
    const toolResultBlock = blocks.find(b => b.type === 'tool_result')

    // A pasted screenshot arrives as a SECOND block on the user's line, beside
    // text that says only `[Image #12]`. Dropping it here — which is what
    // happened until this line existed — leaves the placeholder pointing at
    // nothing, and the UI's image support unreachable for every provider.
    const imageBlocks = blocks.filter(
      (b): b is Extract<CanonicalContentBlock, { type: 'image' }> => b.type === 'image'
    )
    const images = imageBlocks.length > 0 ? imageBlocks.map(b => ({ ...b })) : undefined

    // Combine all text/thinking content
    const textParts = textBlocks.map(block =>
      block.type === 'text' ? block.text : block.thinking || ''
    )
    const combinedText =
      textParts.length > 0 ? this.trimExcessiveNewlines(textParts.join('\n')) : undefined
    const isThinking = textBlocks.some(b => b.type === 'thinking')

    // Build tool use content if present
    let toolUse: ToolUseContent | undefined
    if (toolUseBlock && toolUseBlock.type === 'tool_use') {
      toolUse = {
        type: 'tool_use' as const,
        id: toolUseBlock.id,
        name: toolUseBlock.name,
        input: toolUseBlock.input,
      }
    }

    // Build tool result content if present
    let toolResult: ToolResultContent | undefined
    if (toolResultBlock && toolResultBlock.type === 'tool_result') {
      // Defensive filtering: skip malformed tool_result blocks
      if (
        !toolResultBlock.tool_use_id ||
        toolResultBlock.content === undefined ||
        toolResultBlock.content === ''
      ) {
        return []
      }
      toolResult = {
        type: 'tool_result' as const,
        tool_use_id: toolResultBlock.tool_use_id,
        content: toolResultBlock.content,
        is_error: toolResultBlock.is_error,
      }
    }

    // Split into multiple messages if we have both text and tool blocks
    const messages: ParsedMessage[] = []

    // Create text message if present
    if (combinedText && (toolUse || toolResult)) {
      // Text comes first for assistant messages with tool use
      const textContent: StructuredMessageContent = {
        type: 'structured',
        text: combinedText,
        images,
      }

      const textMessage: ParsedMessage = {
        id: `${canonical.uuid}-text`,
        timestamp,
        type: this.determineMessageType(canonical, combinedText),
        content: textContent,
        metadata: {
          role: canonical.message.role,
          sessionId: canonical.sessionId,
          provider: canonical.provider,
          cwd: canonical.cwd,
          gitBranch: canonical.gitBranch,
          version: canonical.version,
          model: canonical.message.model,
          usage: canonical.message.usage,
          providerMetadata: canonical.providerMetadata,
          requestId: canonical.requestId,
          isMeta: canonical.isMeta,
          isSidechain: canonical.isSidechain,
          userType: canonical.userType,
          hasToolUses: false,
          hasToolResults: false,
          toolCount: 0,
          resultCount: 0,
          isThinking,
        },
        parentId: canonical.parentUuid,
      }

      messages.push(textMessage)
    }

    // Create tool use message if present
    if (toolUse) {
      const toolUseContent: StructuredMessageContent = {
        type: 'structured',
        toolUse,
      }

      const toolUseMessage: ParsedMessage = {
        id: canonical.uuid, // Use original UUID for tool message
        timestamp,
        type: 'tool_use',
        content: toolUseContent,
        metadata: {
          role: 'tool',
          sessionId: canonical.sessionId,
          provider: canonical.provider,
          cwd: canonical.cwd,
          gitBranch: canonical.gitBranch,
          version: canonical.version,
          model: canonical.message.model,
          usage: combinedText ? undefined : canonical.message.usage, // Only if no text message
          providerMetadata: canonical.providerMetadata,
          requestId: canonical.requestId,
          isMeta: canonical.isMeta,
          isSidechain: canonical.isSidechain,
          userType: canonical.userType,
          hasToolUses: true,
          hasToolResults: false,
          toolCount: 1,
          resultCount: 0,
          isThinking: false,
          toolUseId: toolUse.id,
        },
        parentId: canonical.parentUuid,
      }

      messages.push(toolUseMessage)
      return messages // Return both text and tool use messages
    }

    // Create tool result message if present
    if (toolResult) {
      const toolResultContent: StructuredMessageContent = {
        type: 'structured',
        toolResult,
      }

      const toolResultMessage: ParsedMessage = {
        id: canonical.uuid, // Use original UUID for tool result
        timestamp,
        type: 'tool_result',
        content: toolResultContent,
        metadata: {
          role: 'tool',
          sessionId: canonical.sessionId,
          provider: canonical.provider,
          cwd: canonical.cwd,
          gitBranch: canonical.gitBranch,
          version: canonical.version,
          model: canonical.message.model,
          usage: combinedText ? undefined : canonical.message.usage,
          providerMetadata: canonical.providerMetadata,
          requestId: canonical.requestId,
          isMeta: canonical.isMeta,
          isSidechain: canonical.isSidechain,
          userType: canonical.userType,
          hasToolUses: false,
          hasToolResults: true,
          toolCount: 0,
          resultCount: 1,
          isThinking: false,
        },
        parentId: canonical.parentUuid,
        linkedTo: toolResult.tool_use_id,
      }

      messages.push(toolResultMessage)
      return messages // Return tool result (and text if present)
    }

    // Text-only message (no tool blocks), or an image on its own: a paste with
    // no sentence around it is still something the user said.
    if (combinedText || images) {
      const textContent: StructuredMessageContent = {
        type: 'structured',
        text: combinedText,
        images,
      }

      const textMessage: ParsedMessage = {
        id: canonical.uuid,
        timestamp,
        type: this.determineMessageType(canonical, combinedText ?? ''),
        content: textContent,
        metadata: {
          role: canonical.message.role,
          sessionId: canonical.sessionId,
          provider: canonical.provider,
          cwd: canonical.cwd,
          gitBranch: canonical.gitBranch,
          version: canonical.version,
          model: canonical.message.model,
          usage: canonical.message.usage,
          providerMetadata: canonical.providerMetadata,
          requestId: canonical.requestId,
          isMeta: canonical.isMeta,
          isSidechain: canonical.isSidechain,
          userType: canonical.userType,
          hasToolUses: false,
          hasToolResults: false,
          toolCount: 0,
          resultCount: 0,
          isThinking,
        },
        parentId: canonical.parentUuid,
      }

      return [textMessage]
    }

    // Empty message - skip
    return []
  }

  /**
   * Create a message for a thinking block
   */
  private createThinkingMessage(
    canonical: CanonicalMessage,
    block: CanonicalContentBlock & { type: 'thinking' },
    timestamp: Date,
    index: number
  ): ParsedMessage | null {
    const text = block.thinking || ''
    if (!text) return null // Skip empty thinking blocks

    const structuredContent: StructuredMessageContent = {
      type: 'structured',
      text,
    }

    const metadata: ParsedMessage['metadata'] = {
      role: canonical.message.role,
      sessionId: canonical.sessionId,
      provider: canonical.provider,
      cwd: canonical.cwd,
      gitBranch: canonical.gitBranch,
      version: canonical.version,
      model: canonical.message.model,
      usage: index === 0 ? canonical.message.usage : undefined, // Only first gets usage
      providerMetadata: canonical.providerMetadata,
      requestId: canonical.requestId,
      isMeta: canonical.isMeta,
      isSidechain: canonical.isSidechain,
      userType: canonical.userType,
      hasToolUses: false,
      hasToolResults: false,
      toolCount: 0,
      resultCount: 0,
      isThinking: true,
    }

    return {
      id: `${canonical.uuid}-thinking-${index}`,
      timestamp,
      type: 'assistant',
      content: structuredContent,
      metadata,
      parentId: canonical.parentUuid,
    }
  }

  /**
   * Extract session ID from canonical message
   */
  protected extractSessionId(rawMessage: RawLogMessage): string | null {
    const canonical = rawMessage as unknown as CanonicalMessage
    return canonical.sessionId || null
  }

  /**
   * Determine the actual message type by inspecting content blocks
   * Transforms canonical role (user/assistant/meta) into specific message types
   */
  private determineMessageType(
    canonical: CanonicalMessage,
    content: string | CanonicalContentBlock[]
  ): UnifiedMessageType {
    if (canonical.type === 'user') {
      // Check content blocks for tool results
      if (Array.isArray(content) && content.some(block => block.type === 'tool_result')) {
        return 'tool_result'
      }

      // Check for special patterns in both string and structured content
      let textContent = ''
      if (typeof content === 'string') {
        textContent = content
      } else if (Array.isArray(content)) {
        // Extract text from text blocks
        const textBlocks = content.filter(block => block.type === 'text')
        textContent = textBlocks.map(block => block.text).join(' ')
      }

      if (textContent) {
        if (this.isCompactContent(textContent)) return 'compact'
        if (this.isInterruptionContent(textContent)) return 'interruption'
        if (this.isCommandContent(textContent)) return 'command'
      }

      return 'user'
    }

    if (canonical.type === 'assistant') {
      // Check content blocks for tool uses
      if (Array.isArray(content) && content.some(block => block.type === 'tool_use')) {
        return 'tool_use'
      }
      return 'assistant'
    }

    return 'meta'
  }

  /**
   * Trim excessive leading/trailing newlines from text content
   * Removes all leading newlines and keeps max 2 trailing newlines
   */
  private trimExcessiveNewlines(text: string): string {
    // Remove ALL leading newlines
    let trimmed = text.replace(/^\n+/, '')
    // Replace 3+ trailing newlines with 2
    trimmed = trimmed.replace(/\n{3,}$/, '\n\n')
    return trimmed
  }

  /**
   * Check if content is a compact command (context compaction event)
   */
  protected isCompactContent(content: string): boolean {
    return (
      content.includes('<command-name>/compact</command-name>') ||
      (content.trim().startsWith('/compact') && content.trim().length < 50)
    )
  }
}

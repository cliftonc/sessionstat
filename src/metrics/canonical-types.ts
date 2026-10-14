/**
 * Canonical JSONL Format Types
 *
 * TypeScript types matching the Rust canonical format.
 * All providers convert to this unified format for consistent processing.
 */

/**
 * Message type enumeration (aligned with Rust)
 */
export type CanonicalMessageType = 'user' | 'assistant' | 'meta'

/**
 * Token usage statistics
 */
export interface TokenUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/**
 * Content block types for structured messages
 */
export type CanonicalContentBlock =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'thinking'
      thinking?: string
      signature?: string // For Claude encrypted thinking
    }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
    }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string
      is_error?: boolean
    }
  | {
      type: 'image'
      source: {
        type: 'base64'
        media_type: string
        data: string
      }
    }

/**
 * Content can be either plain text or structured blocks
 */
export type ContentValue = string | CanonicalContentBlock[]

/**
 * Message content structure
 */
export interface MessageContent {
  /** Role: "user" or "assistant" */
  role: string

  /** Content: either plain text or structured content blocks */
  content: ContentValue

  /** Model name (for assistant messages) */
  model?: string

  /** Token usage information */
  usage?: TokenUsage
}

/**
 * Canonical JSONL message format (based on Claude Code)
 *
 * This is the unified format that all providers convert to for consistent processing.
 */
export interface CanonicalMessage {
  /** Unique message identifier */
  uuid: string

  /** ISO 8601 timestamp */
  timestamp: string

  /** Message type */
  type: CanonicalMessageType

  /** Session identifier */
  sessionId: string

  /** Provider name (e.g., "claude-code", "gemini-code", "codex") */
  provider: string

  /** Current working directory */
  cwd?: string

  /** Git branch name */
  gitBranch?: string

  /** Provider version */
  version?: string

  /** Parent message UUID (for threading) */
  parentUuid?: string

  /** Whether this is a sidechain message */
  isSidechain?: boolean

  /** User type */
  userType?: string

  /** Message content */
  message: MessageContent

  /** Optional provider-specific metadata
   * Preserves provider-specific fields that don't fit in canonical schema
   */
  providerMetadata?: Record<string, unknown>

  /** Whether this is a meta message (system events) */
  isMeta?: boolean

  /** Request ID from provider */
  requestId?: string

  /** Tool use result data */
  toolUseResult?: unknown
}

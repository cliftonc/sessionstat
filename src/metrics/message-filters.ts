/**
 * Shared predicates for classifying parsed messages.
 *
 * These exist because three metrics - input clarity, interruption rate and iteration
 * count - each grew their own idea of "a human turn" and "an assistant turn", and the
 * ideas disagreed. Two disagreements were live bugs:
 *
 *   - The parser re-types any assistant message containing a tool_use block to
 *     `'tool_use'`, so `type === 'assistant'` matches only text-only replies. Anything
 *     using it as a denominator or an adjacency test was silently wrong on tool-heavy
 *     sessions.
 *   - Sub-agent traffic (`isSidechain`) was excluded from some counts and not others.
 *     Sidechain prompts are machine-written and unusually dense with paths and
 *     identifiers, so including them flatters exactly the sessions that delegate most.
 *
 * One definition each, used everywhere.
 */

import { isStructuredMessageContent } from './types.js'
import type { ParsedMessage } from './types.js'

/**
 * The ESC marker, which must be the WHOLE message - not merely present in it.
 *
 * Two forms occur in real transcripts, in different places:
 *   `[Request interrupted by user]`             - a user TEXT block (184 seen)
 *   `[Request interrupted by user for tool use]` - a TOOL_RESULT block (12 seen)
 *
 * ANCHORED DELIBERATELY. A substring test is catastrophically wrong here, because a
 * session that greps for the marker, reads this file, or displays a transcript containing
 * it will have the phrase all over its tool results. Measured on one real session: 21
 * occurrences of the phrase, of which exactly 2 were interruptions - the other 19 were
 * that session's own search output. Requiring the marker to BE the message rather than
 * appear in it is what separates an interruption from a discussion of interruptions.
 */
const INTERRUPTION_MARKER = /^\[Request interrupted by user[^\]]*\]$/

/** True when a string is nothing but the marker. */
function isMarkerOnly(text: string | null | undefined): boolean {
  return typeof text === 'string' && INTERRUPTION_MARKER.test(text.trim())
}

/**
 * Whether a message IS an interruption - a text block or tool result consisting solely of
 * the ESC marker. Tool *inputs* are never inspected: an agent prompt that mentions the
 * marker is not an interruption.
 */
export function hasInterruptionMarker(message: ParsedMessage): boolean {
  const content = message.content

  if (typeof content === 'string') return isMarkerOnly(content)

  if (isStructuredMessageContent(content)) {
    if (isMarkerOnly(content.text)) return true

    const result = content.toolResult?.content
    if (isMarkerOnly(typeof result === 'string' ? result : null)) return true
  }

  return false
}

/** Sub-agent traffic, not the person at the keyboard. */
export function isSidechain(message: ParsedMessage): boolean {
  return message.metadata?.isSidechain === true
}

/**
 * A turn the AI took, however the parser typed it.
 *
 * `'tool_use'` is an assistant message that happened to contain a tool call; treating it
 * as anything else makes tool-heavy sessions look like the AI never spoke.
 */
export function isAssistantTurn(message: ParsedMessage): boolean {
  return message.type === 'assistant' || message.type === 'tool_use'
}

/**
 * A prompt actually typed by the person.
 *
 * The parser has already split `tool_result`, `command`, `compact` and `interruption` out
 * of the `'user'` type, so this is genuinely human input - but NOT all of it: an
 * interruption is also something the person did. Anything using this as a denominator for
 * "share of my inputs" has to add interruptions back, or it can exceed 100%.
 */
export function isHumanPrompt(message: ParsedMessage): boolean {
  return message.type === 'user' && !isSidechain(message)
}

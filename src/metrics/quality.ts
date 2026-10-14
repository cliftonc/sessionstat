/**
 * Unified Quality Metrics Processor
 *
 * Works for all providers using the canonical format.
 * Measures task success rate, iteration count, and process quality.
 */

import { isAssistantTurn, isHumanPrompt, isSidechain } from './message-filters.js'
import { BaseMetricProcessor } from './metric-processor.js'
import { countByCapability, getToolCapability } from './tool-capabilities.js'
import type { QualityMetrics, ToolResultContent, ToolUseContent } from './types.js'
import { isStructuredMessageContent } from './types.js'
import type { ParsedMessage, ParsedSession } from './types.js'

/**
 * Version of the deterministic process-quality scorer.
 *
 * Stamped onto every result. Scores from different versions are not comparable, so
 * anything trending this metric should group by it - notably the composite index, whose
 * `aiLeverage` dimension averages this score over a 30-day window and will therefore mix
 * v1 and v2 during the transition.
 *
 * v1 - literal Claude Code tool names; every other provider scored near zero.
 * v2 - provider-agnostic capability mapping (see `tool-capabilities.ts`).
 * v3 - renormalised over applicable components, planning and progress tracking satisfied
 *      by a union of tool families, and `TaskCreate`/`TaskUpdate` recognised.
 *
 * v3 CHANGES WHAT THIS STAMP IS FOR. Up to v2 it existed to keep incomparable eras apart
 * in trends. From v3 the whole corpus is reprocessed instead, so there is one definition
 * and nothing to split - and the stamp's job becomes marking BACKFILL PROGRESS. A
 * `session_metrics` row whose version is anything other than the current one has not been
 * reprocessed yet, which is what makes the backfill resumable and verifiable by query
 * rather than by trust. Note that rows written before the server path populated this
 * column at all are NULL, not 'v2', so completion checks must test `IS DISTINCT FROM`.
 */
export const PROCESS_QUALITY_SCORER_VERSION = 'v3'

/**
 * Whether a tool call wrote a plan file.
 *
 * Plan files live under `.claude/plans/`; writing one is how current Claude Code records
 * a multi-step approach now that the task-list tools are gone.
 */
function isPlanFileWrite(tool: ToolUseContent): boolean {
  if (getToolCapability(tool.name) !== 'write') return false

  const input = tool.input as { file_path?: unknown } | undefined
  const filePath = typeof input?.file_path === 'string' ? input.file_path : ''

  return filePath.includes('/.claude/plans/')
}

export class CanonicalQualityProcessor extends BaseMetricProcessor {
  readonly name = 'canonical-quality'
  readonly metricType = 'quality' as const
  readonly description =
    'Measures task success rate, iteration count, and process quality (unified for all providers)'

  async process(session: ParsedSession): Promise<QualityMetrics> {
    const toolUses = this.extractToolUses(session)
    const toolResults = this.extractToolResults(session)

    // Calculate task success rate
    const successfulOperations = toolResults.filter(result => !result.is_error).length
    const totalOperations = toolResults.length
    const taskSuccessRate =
      totalOperations > 0 ? Math.round((successfulOperations / totalOperations) * 100) : 0

    // Calculate iteration count
    const iterationCount = this.calculateIterations(session)

    // Detect plan mode and todo tracking usage
    const planModeUsage = this.detectPlanModeUsage(toolUses)
    const todoTrackingUsage = this.detectTodoTrackingUsage(toolUses)

    // Detect over-the-top affirmations
    const overTopAffirmations = this.detectOverTopAffirmations(session)

    // Calculate process quality score
    const processQualityScore = this.calculateProcessQuality(
      toolUses,
      session,
      planModeUsage.used,
      todoTrackingUsage.used
    )

    return {
      task_success_rate: taskSuccessRate,
      iteration_count: iterationCount,
      process_quality_score: processQualityScore,
      used_plan_mode: planModeUsage.used,
      used_todo_tracking: todoTrackingUsage.used,
      over_top_affirmations: overTopAffirmations.count,
      metadata: {
        successful_operations: successfulOperations,
        total_operations: totalOperations,
        exit_plan_mode_count: planModeUsage.count,
        todo_write_count: todoTrackingUsage.count,
        over_top_affirmations_phrases: overTopAffirmations.phrases,
        process_quality_scorer_version: PROCESS_QUALITY_SCORER_VERSION,
        improvement_tips: this.generateImprovementTips(
          taskSuccessRate,
          iterationCount,
          processQualityScore,
          planModeUsage.used,
          todoTrackingUsage.used
        ),
      },
    }
  }

  /**
   * Extract tool uses from session
   */
  private extractToolUses(session: ParsedSession): ToolUseContent[] {
    const toolUses: ToolUseContent[] = []

    for (const message of session.messages) {
      if (isStructuredMessageContent(message.content) && message.content.toolUse) {
        toolUses.push(message.content.toolUse)
      }
    }

    return toolUses
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
   * Conversational rounds: prompts the person sent AFTER the AI had already produced work.
   *
   * Structural, not lexical. This used to look for refinement phrases anywhere in the
   * message - "actually,", "instead of", "rather than", "make it" - which was almost pure
   * noise: measured over 36 real sessions, "rather than" and "instead of" alone produced
   * 28 of 42 hits, and every one of them was a specification like "use Drizzle rather than
   * Prisma", not a correction.
   *
   * ANCHORING THOSE PATTERNS TO THE START OF THE MESSAGE WAS TRIED AND MEASURED AT EXACTLY
   * ZERO across those same 36 sessions - trading noise for a constant is not an
   * improvement. Real corrections in the corpus open with the substance, not a connective:
   * "the policy should be explicitly selected at setup - not default to 'allow'", "I dont
   * think that page is linked from anywhere". Recognising those is a semantic judgement,
   * and the session already has an LLM pass (`ai_model_phase_analysis`) that labels
   * `correction` phases. A deterministic metric should not pretend to do it too.
   *
   * So this counts what it can count exactly: how many times the person had to come back.
   * That is what the metric is named for, what its tooltip claims ("fewer iterations =
   * clearer requirements") and what its thresholds were calibrated for - measured 0-29
   * with a median of 3, against bands of <=5 excellent and <=10 warning.
   *
   * Interruptions are excluded; they are counted separately as `total_interruptions`.
   */
  private calculateIterations(session: ParsedSession): number {
    let iterations = 0
    // Has the AI acted since the person last spoke? Deliberately NOT "is the immediately
    // preceding message an assistant one": a follow-up typed during tool use arrives after
    // the tool_result. `isAssistantTurn` also covers `'tool_use'`, which the parser
    // substitutes for `'assistant'` on any reply containing a tool call.
    let assistantActedSinceLastPrompt = false

    for (const message of session.messages) {
      if (isSidechain(message)) continue

      if (!isHumanPrompt(message)) {
        if (isAssistantTurn(message)) assistantActedSinceLastPrompt = true
        continue
      }

      // An empty message is a harness artefact, not the person coming back.
      if (this.extractTextContent(message).trim().length === 0) continue

      if (assistantActedSinceLastPrompt) {
        iterations++
      }

      assistantActedSinceLastPrompt = false
    }

    return iterations
  }

  /**
   * Detect plan mode usage
   */
  private detectPlanModeUsage(toolUses: ToolUseContent[]): { used: boolean; count: number } {
    const planTools = toolUses.filter(tool => getToolCapability(tool.name) === 'plan')
    return {
      used: planTools.length > 0,
      count: planTools.length,
    }
  }

  /**
   * Detect progress-tracking usage.
   *
   * Counts an explicit task-list tool OR a written plan file, because the tool has been
   * removed and reintroduced under different names and a metric pinned to any one of them
   * measures the client version rather than the practice. Across 913 local sessions:
   * `TodoWrite` was already gone, `TaskCreate`/`TaskUpdate` ran for eight releases, and
   * current versions ship nothing - while plan files kept being written throughout.
   *
   * A plan file is the weaker signal of the two: it records intent up front, where a task
   * tool also records progress against it. It is accepted because the alternative is
   * scoring every modern session zero for a practice it demonstrably followed.
   */
  private detectTodoTrackingUsage(toolUses: ToolUseContent[]): { used: boolean; count: number } {
    const todoTools = toolUses.filter(tool => getToolCapability(tool.name) === 'todo')
    const planFileWrites = toolUses.filter(tool => isPlanFileWrite(tool)).length

    const count = todoTools.length + planFileWrites
    return {
      used: count > 0,
      count,
    }
  }

  /**
   * Observable good practice in how the session was run, as a percentage of what this
   * session COULD have demonstrated.
   *
   * Renormalised rather than scored out of a flat 100. The flat version quietly punished
   * sessions for tooling they never had: when Claude Code dropped its task-list tool, the
   * +20 for progress tracking became unreachable and every session silently capped at 80.
   * Components a session had no opportunity to satisfy are now left out of the denominator
   * instead of counted as failures.
   */
  private calculateProcessQuality(
    toolUses: ToolUseContent[],
    _session: ParsedSession,
    usedPlanMode: boolean,
    usedTodoTracking: boolean
  ): number {
    // Capability-based, so the same behaviour scores the same on every provider.
    const counts = countByCapability(toolUses.map(tool => tool.name))

    const hasWrites = counts.write > 0
    const hasReads = counts.read > 0

    let earned = 0
    let applicable = 0

    // Planning and progress tracking are always applicable, because each is satisfied by
    // a UNION of tool families rather than one vendor name - see `detectTodoTrackingUsage`.
    applicable += 30
    if (usedPlanMode) earned += 30

    applicable += 20
    if (usedTodoTracking) earned += 20

    // The remaining components describe how writes were carried out. A session that never
    // wrote anything had no opportunity to satisfy them, so they are excluded from the
    // denominator rather than scored as failures.
    if (hasWrites) {
      applicable += 25
      if (hasReads) earned += 25 // read before write

      applicable += 15
      if (counts.execute > 0) earned += 15 // verify after write

      applicable += 10
      if (counts.write > 1 && counts.write <= 5) earned += 10 // incremental
    }

    if (applicable === 0) return 0

    let score = Math.round((earned / applicable) * 100)

    // Penalty applies after renormalising: reading far more than writing suggests the AI
    // was hunting for context rather than being pointed at it.
    if (hasReads && counts.read / (counts.write || 1) > 2) {
      score -= 10
    }

    return Math.max(0, Math.min(score, 100))
  }

  /**
   * Detect over-the-top affirmations
   */
  private detectOverTopAffirmations(session: ParsedSession): { count: number; phrases: string[] } {
    const affirmationPatterns = [
      /\byou'?re\s+right\b/i,
      /\byou'?re\s+absolutely\s+right\b/i,
      /\byou'?re\s+completely\s+right\b/i,
      /\byou'?re\s+totally\s+right\b/i,
      /\byou'?re\s+100%\s+right\b/i,
      /\byou'?re\s+spot\s+on\b/i,
      /\byou'?re\s+exactly\s+right\b/i,
      /\bexactly!?\s*$/i,
      /\babsolutely!?\s*$/i,
      /\bperfect!?\s*$/i,
      /\bbrilliant!?\s*$/i,
      /\bexcellent!?\s*$/i,
      /\bthat'?s\s+absolutely\s+right\b/i,
      /\bthat'?s\s+completely\s+correct\b/i,
      /\bthat'?s\s+exactly\s+right\b/i,
      /\bthat'?s\s+spot\s+on\b/i,
      /\bthat'?s\s+perfect\b/i,
      /\byes!+\s*$/i,
      /\bawesome!+\s*$/i,
      /\bfantastic!+\s*$/i,
      /\bwonderful!+\s*$/i,
    ]

    let totalCount = 0
    const foundPhrases: string[] = []

    const assistantMessages = session.messages.filter(m => m.type === 'assistant')

    for (const message of assistantMessages) {
      const content = this.extractTextContent(message).toLowerCase()

      for (const pattern of affirmationPatterns) {
        const matches = content.match(pattern)
        if (matches) {
          totalCount++
          foundPhrases.push(matches[0])
        }
      }
    }

    return {
      count: totalCount,
      phrases: Array.from(new Set(foundPhrases)),
    }
  }

  /**
   * Extract text content from message
   */
  private extractTextContent(message: ParsedMessage): string {
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
  private generateImprovementTips(
    taskSuccessRate: number,
    iterationCount: number,
    processQuality: number,
    usedPlanMode: boolean,
    usedTodoTracking: boolean
  ): string[] {
    const tips: string[] = []

    const hasQualityIssues = taskSuccessRate < 70 || iterationCount > 10 || processQuality < 50

    // Plan mode and todo tracking tips
    if (hasQualityIssues || processQuality < 60) {
      if (!usedPlanMode && !usedTodoTracking) {
        tips.push('For complex tasks, use plan mode to organize your approach upfront')
        tips.push('Consider using TodoWrite to track progress on multi-step tasks')
      } else if (!usedPlanMode) {
        tips.push('Try using plan mode to outline your approach before starting complex tasks')
      } else if (!usedTodoTracking) {
        tips.push('Consider using TodoWrite to track progress and ensure all steps are completed')
      }
    }

    // Task success and iteration tips
    if (taskSuccessRate < 70) {
      tips.push(
        'Low success rate - ensure comprehensive upfront context (file paths, specs, code examples)'
      )
      tips.push('Consider improving documentation to reduce AI exploration')
    }

    if (iterationCount > 10) {
      tips.push(
        'Many iterations - consider whether initial prompt provided enough technical detail and context'
      )
    }

    // Excellence recognition
    if (
      usedPlanMode &&
      usedTodoTracking &&
      taskSuccessRate > 80 &&
      iterationCount <= 5 &&
      processQuality > 80
    ) {
      tips.push(
        'Outstanding! Excellent process discipline with plan mode, todo tracking, and clear context'
      )
    } else if ((usedPlanMode || usedTodoTracking) && taskSuccessRate > 75 && processQuality > 70) {
      tips.push(
        'Great collaboration! Your use of planning tools shows excellent AI process discipline'
      )
    } else if (taskSuccessRate > 80 && iterationCount <= 5 && processQuality > 70) {
      tips.push('Excellent! Effective context and steering led to efficient execution')
    }

    return tips
  }
}

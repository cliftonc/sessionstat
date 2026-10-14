/**
 * Unified Usage Metrics Processor
 *
 * Works for all providers using the canonical format.
 * Measures Read/Write ratio and input clarity.
 */

import { BaseMetricProcessor } from './metric-processor.js'
import { getToolCapability, normalizeToolName } from './tool-capabilities.js'
import type { ToolResultContent, ToolUseContent, UsageMetrics } from './types.js'
import { isStructuredMessageContent } from './types.js'
import type { ParsedMessage, ParsedSession } from './types.js'

/**
 * Text the harness injects into user messages: command wrappers, system reminders,
 * background-task notifications.
 *
 * None of it was typed by the developer, and it badly distorts a clarity score in both
 * directions. Notifications and command output are dense with file paths and identifiers,
 * which inflates the score - two real sessions measured 47 and 42, dropping to 9 and 12
 * once stripped. Caveat banners are prose, which deflates it.
 */
const INJECTED_CONTENT =
  /<(system-reminder|local-command-caveat|local-command-stdout|task-notification|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g
import { isHumanPrompt } from './message-filters.js'

/**
 * Tools that poll a running command's output. They classify as execution, which is right
 * for verification scoring, but the ratio has always counted Claude Code's `BashOutput` as a
 * read; Copilot CLI's `read_bash` is the same operation and is counted the same way.
 */
const OUTPUT_POLL_TOOLS = new Set(['bashoutput', 'readbash'])

function isReadForRatio(name: string): boolean {
  return getToolCapability(name) === 'read' || OUTPUT_POLL_TOOLS.has(normalizeToolName(name))
}

export class CanonicalUsageProcessor extends BaseMetricProcessor {
  readonly name = 'canonical-usage'
  readonly metricType = 'usage' as const
  readonly description = 'Measures Read/Write ratio and input clarity (unified for all providers)'

  async process(session: ParsedSession): Promise<UsageMetrics> {
    const toolUses = this.extractToolUses(session)
    const toolResults = this.extractToolResults(session)
    // Sidechain prompts are machine-written sub-agent instructions, not the developer's
    // own words, and they are dense with paths and identifiers - counting them would
    // flatter exactly the sessions that delegate most.
    const userMessages = session.messages.filter(isHumanPrompt)

    // Read/Write ratio, by what each tool does rather than what Claude Code calls it.
    // The literal list (`Read`, `Grep`, `Glob`, `BashOutput` / `Write`, `Edit`) meant every
    // other provider read 0 writes and reported its read count as the ratio.
    const readCount = toolUses.filter(tool => isReadForRatio(tool.name)).length
    const writeCount = toolUses.filter(tool => getToolCapability(tool.name) === 'write').length

    const readWriteRatio = writeCount > 0 ? Number((readCount / writeCount).toFixed(2)) : readCount

    // Calculate input clarity score
    const inputClarityScore = this.calculateInputClarityScore(userMessages)

    // Calculate total lines read
    const totalLinesRead = this.calculateLinesRead(toolUses, toolResults)

    // Interpret Read/Write ratio (lower is better - AI knows where to go)
    const ratioQuality =
      readWriteRatio <= 2 ? 'excellent' : readWriteRatio <= 5 ? 'acceptable' : 'poor'

    return {
      read_write_ratio: readWriteRatio,
      input_clarity_score: inputClarityScore,
      metadata: {
        read_operations: readCount,
        write_operations: writeCount,
        total_user_messages: userMessages.length,
        total_lines_read: totalLinesRead,
        ratio_quality: ratioQuality, // 'excellent' | 'acceptable' | 'poor' (lower ratio is better)
        improvement_tips: this.generateImprovementTips(readWriteRatio, inputClarityScore),
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
   * Density of concrete, actionable detail in the developer's own messages.
   *
   * Scored PER MESSAGE and then averaged. It used to pool - `sum(score) / sum(words)`
   * across the whole session - which quietly inverted the metric: the marker counts
   * saturate (`countTechnicalTerms` returns distinct keywords present, so it stops growing
   * around 70) while the word count does not, so one long message dragged down every short
   * precise one and writing a thorough prompt LOWERED the score. Measured on real sessions
   * the pooled form collapsed everything into 3-12%; the per-message mean spreads 0-52%,
   * which is the range the thresholds in `metricThresholds.ts` were written for.
   *
   * Messages with no words are skipped rather than counted as zero.
   */
  private calculateInputClarityScore(userMessages: ParsedMessage[]): number {
    if (userMessages.length === 0) return 0

    const perMessageScores: number[] = []

    for (const message of userMessages) {
      const content = this.extractDeveloperText(message)
      const words = content.split(/\s+/).filter(word => word.length > 0)
      // Nothing left after stripping means the message was pure harness injection.
      if (words.length === 0) continue

      // Count technical indicators
      const technicalTerms = this.countTechnicalTerms(content)
      const codeSnippets = this.countCodeSnippets(content)
      const fileReferences = this.countFileReferences(content)
      const specificityMarkers = this.countSpecificityMarkers(content)
      const atReferences = this.countAtReferences(content)
      const imageAttachments = this.countImageAttachments(message)

      // Weighted score (reduced code snippet bias from ×2 to ×1.5)
      const messageScore =
        technicalTerms +
        codeSnippets * 1.5 +
        fileReferences +
        specificityMarkers * 2 +
        atReferences * 2 +
        imageAttachments * 3

      perMessageScores.push(Math.min(Math.round((messageScore / words.length) * 100), 100))
    }

    if (perMessageScores.length === 0) return 0

    const mean = perMessageScores.reduce((a, b) => a + b, 0) / perMessageScores.length
    return Math.min(Math.round(mean), 100)
  }

  /**
   * The developer's own words, with harness-injected blocks removed.
   *
   * Only used for clarity scoring: other metrics want the message as it was stored.
   */
  private extractDeveloperText(message: ParsedMessage): string {
    return this.extractTextContent(message).replace(INJECTED_CONTENT, ' ').trim()
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
   * Count technical keywords in content
   */
  private countTechnicalTerms(content: string): number {
    const technicalKeywords = [
      // Programming concepts
      'function',
      'variable',
      'class',
      'method',
      'api',
      'interface',
      'type',
      'import',
      'export',
      'async',
      'await',
      'const',
      'let',
      'enum',
      'struct',
      'trait',
      // Languages & frameworks
      'typescript',
      'javascript',
      'python',
      'rust',
      'go',
      'java',
      'react',
      'vue',
      'svelte',
      'angular',
      'next.js',
      'nextjs',
      'astro',
      'node',
      'deno',
      'bun',
      // Database & backend
      'database',
      'query',
      'schema',
      'table',
      'column',
      'index',
      'migration',
      'sql',
      'postgres',
      'postgresql',
      'mongodb',
      'redis',
      'drizzle',
      'prisma',
      // Frontend & styling
      'component',
      'tailwind',
      'css',
      'html',
      'dom',
      'jsx',
      'tsx',
      // Tools & packages
      'npm',
      'pnpm',
      'yarn',
      'package',
      'build',
      'test',
      'lint',
      'format',
      'webpack',
      'vite',
      'esbuild',
      // Architecture
      'server',
      'client',
      'endpoint',
      'route',
      'middleware',
      'hook',
      'provider',
      'context',
      'state',
    ]

    const contentLower = content.toLowerCase()
    return technicalKeywords.filter(keyword => contentLower.includes(keyword)).length
  }

  /**
   * Count code snippets in content
   */
  private countCodeSnippets(content: string): number {
    const codeBlocks = (content.match(/```[\s\S]*?```/g) || []).length
    const inlineCode = (content.match(/`[^`\n]+`/g) || []).length
    return codeBlocks + inlineCode
  }

  /**
   * Count file references in content
   */
  private countFileReferences(content: string): number {
    const fileExtensions = /\.\w{1,4}(\s|$|[^\w])/g
    const pathPatterns = /[\/\\][\w\-\.\/\\]+/g

    const extensions = (content.match(fileExtensions) || []).length
    const paths = (content.match(pathPatterns) || []).length

    return extensions + paths
  }

  /**
   * Count specificity markers: line numbers, function names, concrete examples
   */
  private countSpecificityMarkers(content: string): number {
    let count = 0

    // Line number references (e.g., "file.ts:123", "line 45")
    const lineNumberPatterns = [
      /:\d+/g, // file.ts:123
      /line\s+\d+/gi, // line 45
      /lines?\s+\d+-\d+/gi, // lines 10-20
    ]
    for (const pattern of lineNumberPatterns) {
      count += (content.match(pattern) || []).length
    }

    // Function/method references (e.g., "calculateTotal()", "UserService.login")
    const functionPatterns = [
      /\w+\(\)/g, // functionName()
      /\w+\.\w+\(/g, // object.method(
    ]
    for (const pattern of functionPatterns) {
      count += (content.match(pattern) || []).length
    }

    // Specific identifiers in camelCase or PascalCase
    const identifierPattern = /\b[A-Z][a-z]+([A-Z][a-z]+)+\b/g // PascalCase
    count += (content.match(identifierPattern) || []).length

    return count
  }

  /**
   * Count @ file references (e.g., @src/file.ts, @components/Button.tsx)
   */
  private countAtReferences(content: string): number {
    const atReferencePattern = /@[\w\-\.\/]+/g
    return (content.match(atReferencePattern) || []).length
  }

  /**
   * Count image attachments in message
   */
  private countImageAttachments(message: ParsedMessage): number {
    let count = 0

    // Check for image content blocks in array content
    if (typeof message.content !== 'string' && Array.isArray(message.content)) {
      count += message.content.filter((block: { type?: string }) => block.type === 'image').length
    }

    // Check metadata for image attachments
    if (message.metadata?.attachments) {
      const attachments = Array.isArray(message.metadata.attachments)
        ? message.metadata.attachments
        : [message.metadata.attachments]

      count += attachments.filter((att: string | { type?: string }) => {
        if (typeof att === 'string') {
          return att.toLowerCase().match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)
        }
        return att?.type?.startsWith('image/')
      }).length
    }

    return count
  }

  /**
   * Calculate total lines read from tool results
   */
  private calculateLinesRead(toolUses: ToolUseContent[], toolResults: ToolResultContent[]): number {
    let total = 0

    // Map tool uses to results
    const resultMap = new Map<string, ToolResultContent>()
    for (const result of toolResults) {
      if (result.tool_use_id) {
        resultMap.set(result.tool_use_id, result)
      }
    }

    for (const tool of toolUses) {
      const result = resultMap.get(tool.id)
      if (!result || !result.content) continue

      // Count lines for read operations. Only the result's line count is used, which means
      // the same thing whatever the provider: Claude's `Read`, Copilot's `view`, OpenCode's
      // `read`. Reads done through a shell (`cat`, Codex's `rg`) are not visible here.
      if (getToolCapability(tool.name) === 'read') {
        const content =
          typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
        const lines = content.split('\n').filter(l => l.trim()).length
        total += lines
      }
    }

    return total
  }

  /**
   * Generate improvement tips
   */
  private generateImprovementTips(readWriteRatio: number, inputClarityScore: number): string[] {
    const tips: string[] = []

    if (readWriteRatio > 5) {
      tips.push(
        'High Read/Write ratio suggests AI is searching - provide specific file paths upfront'
      )
      tips.push('Include relevant code context in your requests to reduce exploration')
    }

    if (readWriteRatio <= 2) {
      tips.push('Excellent efficiency! AI found and modified files quickly')
    }

    if (inputClarityScore < 20) {
      tips.push('Low input clarity - try including more technical details and code examples')
      tips.push('Specify exact file paths and function names for better results')
    }

    if (inputClarityScore > 50) {
      tips.push('Great technical communication! Clear, specific inputs lead to better results')
    }

    return tips
  }
}

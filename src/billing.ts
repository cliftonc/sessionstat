import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { home } from './paths.js'

/**
 * Who pays for this machine's Claude Code sessions.
 *
 * - `subscription`: a Claude plan (Pro, Max, Team...) absorbs it; nobody is invoiced per token.
 * - `api`: billed per token - an API key, a gateway token, or a cloud provider.
 * - `unknown`: nothing to go on.
 *
 * Decided where the session ran and stored on the session, because one PR can carry sessions
 * from several people on different plans.
 *
 * Environment first, because Claude Code lets it override a logged-in subscription: an API key
 * or auth token in the environment is used instead of the plan, and Bedrock / Vertex / Foundry
 * never touch it. Otherwise the logged-in account's billing type from Claude Code's config.
 */
export type Billing = 'subscription' | 'api' | 'unknown'

const API_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]

function claudeConfigPath(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR
    ? join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : join(home(), '.claude.json')
}

export async function detectBilling(env: NodeJS.ProcessEnv = process.env): Promise<Billing> {
  if (API_ENV.some(name => env[name])) return 'api'
  let account: { billingType?: unknown } | undefined
  try {
    const config = JSON.parse(await readFile(claudeConfigPath(env), 'utf-8')) as {
      oauthAccount?: { billingType?: unknown }
    }
    account = config.oauthAccount
  } catch {
    return 'unknown'
  }
  if (!account) return 'unknown'
  return typeof account.billingType === 'string' && account.billingType.includes('subscription')
    ? 'subscription'
    : 'api'
}

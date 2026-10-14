import { basename } from 'node:path'
import { type CommandRunner, runCommand } from './runner.js'

/**
 * Adapted from guidemode `packages/cli/src/utils/git.ts` (`getGitMetadata`, `normalizeGitUrl`,
 * `extractRepoName`). Runs git through the injected runner so tests need no repository.
 */

const GIT_TIMEOUT = 5000

export interface GitMetadata {
  remoteUrl: string | null
  branch: string | null
  commitHash: string | null
  repoName: string
  /** Absolute repository root, or null outside a git repository. */
  toplevel: string | null
}

async function git(run: CommandRunner, args: string[], cwd: string): Promise<string | null> {
  const result = await run('git', args, { cwd, timeoutMs: GIT_TIMEOUT })
  if (result.code !== 0) return null
  const out = result.stdout.trim()
  return out.length > 0 ? out : null
}

export function normalizeGitUrl(url: string): string {
  if (url.startsWith('git@github.com:')) {
    return `https://github.com/${url.slice('git@github.com:'.length)}`
  }
  if (url.startsWith('ssh://git@github.com/')) {
    return `https://github.com/${url.slice('ssh://git@github.com/'.length)}`
  }
  return url
}

export function extractRepoName(url: string): string {
  const match = url.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?\/?$/)
  return match ? match[1] : ''
}

export function isGitHubRemote(url: string | null): boolean {
  return Boolean(url && /^(https:\/\/|git@|ssh:\/\/git@)github\.com[/:]/.test(url))
}

export async function getGitMetadata(
  cwd: string,
  run: CommandRunner = runCommand
): Promise<GitMetadata> {
  const fallback: GitMetadata = {
    remoteUrl: null,
    branch: null,
    commitHash: null,
    repoName: 'unknown',
    toplevel: null,
  }
  if (!cwd) return fallback

  const [remote, toplevel, branch, commitHash] = await Promise.all([
    git(run, ['remote', 'get-url', 'origin'], cwd),
    git(run, ['rev-parse', '--show-toplevel'], cwd),
    git(run, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    git(run, ['rev-parse', 'HEAD'], cwd),
  ])

  if (!toplevel) return fallback

  const remoteUrl = remote ? normalizeGitUrl(remote) : null
  let repoName = remoteUrl ? extractRepoName(remoteUrl) : ''
  if (!repoName) repoName = basename(toplevel)

  return {
    remoteUrl,
    // A detached HEAD reports "HEAD", which no PR is ever opened from.
    branch: branch && branch !== 'HEAD' ? branch : null,
    commitHash,
    repoName,
    toplevel,
  }
}

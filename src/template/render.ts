import { readFile } from 'node:fs/promises'
import Mustache from 'mustache'
import { MARKER } from '../gh.js'
import { log } from '../log.js'
import { legacyRepoTemplatePath, paths, repoTemplatePath } from '../paths.js'
import { type DataBlock, serializeDataBlock } from './data.js'
import DEFAULT_TEMPLATE from './default.md'
import type { CommentView } from './view.js'

export { DEFAULT_TEMPLATE }

export type TemplateSource = 'repo' | 'home' | 'default'

export interface ResolvedTemplate {
  source: TemplateSource
  path: string | null
  template: string
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

/**
 * First match wins: `<repo>/.claude/sessionstat.md` (or the older `<repo>/.sessionstat.md`),
 * then `~/.sessionstat/template.md`, then ours.
 */
export async function resolveTemplate(repoRoot: string | null): Promise<ResolvedTemplate> {
  if (repoRoot) {
    for (const path of [repoTemplatePath(repoRoot), legacyRepoTemplatePath(repoRoot)]) {
      const template = await readIfExists(path)
      if (template !== null) return { source: 'repo', path, template }
    }
  }
  const homePath = paths.homeTemplate()
  const home = await readIfExists(homePath)
  if (home !== null) return { source: 'home', path: homePath, template: home }
  return { source: 'default', path: null, template: DEFAULT_TEMPLATE }
}

/** Markdown, not HTML: leave values as they are. */
const NO_ESCAPE = { escape: (value: unknown) => String(value) }

function renderRaw(template: string, view: CommentView): string {
  // Parse first so a malformed template fails here, as a thrown error, rather than half-rendering.
  Mustache.parse(template)
  return Mustache.render(template, view, {}, NO_ESCAPE)
}

/** Blank lines that a hidden section leaves behind collapse to one. */
function tidy(markdown: string): string {
  return `${markdown
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`
}

export interface RenderResult {
  body: string
  source: TemplateSource
  path: string | null
  /** Set when the chosen template failed and the default was used instead. */
  fallbackError?: string
}

/**
 * Render the comment body. The marker (first) and the data block (last) are always added here,
 * not by the template, so an edited template can never stop us finding and updating our own
 * comment, or hide the numbers from anything that reads them back.
 */
export async function renderComment(
  view: CommentView,
  repoRoot: string | null,
  data: DataBlock
): Promise<RenderResult> {
  const resolved = await resolveTemplate(repoRoot)
  let markdown: string
  let fallbackError: string | undefined
  try {
    markdown = renderRaw(resolved.template, view)
  } catch (err) {
    fallbackError = err instanceof Error ? err.message : String(err)
    await log(
      'ERROR',
      `Template ${resolved.path ?? '(default)'} failed to render, using the default: ${fallbackError}`
    )
    markdown = renderRaw(DEFAULT_TEMPLATE, view)
  }
  const withoutMarker = markdown.split(MARKER).join('')
  return {
    body: `${MARKER}\n${tidy(withoutMarker)}\n${serializeDataBlock(data)}\n`,
    source: fallbackError ? 'default' : resolved.source,
    path: fallbackError ? null : resolved.path,
    ...(fallbackError ? { fallbackError } : {}),
  }
}

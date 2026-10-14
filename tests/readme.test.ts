import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { COMMANDS } from '../src/commands.js'
import { buildProgram } from '../src/program.js'

/**
 * Every `sessionstat …` the README shows, in code spans and code blocks, must be a real command
 * with real flags, so the docs cannot go on describing a CLI that no longer exists.
 */

const README = join(import.meta.dirname, '..', 'README.md')

function examples(markdown: string): string[] {
  const code = [
    ...[...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap(m => m[1].split('\n')),
    ...[...markdown.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map(m => m[1]),
  ]
  return code
    .flatMap(line => line.split(/&&|;|\|(?!\|)/))
    .map(part => part.replace(/#.*$/, '').trim())
    .map(part => part.match(/(?:^|\s)(sessionstat\s+[a-z][^\s]*(?:\s+.*)?)$/)?.[1] ?? '')
    .filter(Boolean)
}

function resolve(program: Command, words: string[]): { cmd: Command; name: string } | null {
  const parent = program.commands.find(
    c => c.name() === words[0] || c.aliases().includes(words[0] ?? '')
  )
  if (!parent) return null
  if (parent.commands.length === 0) return { cmd: parent, name: parent.name() }
  const child = parent.commands.find(c => c.name() === words[1])
  return child ? { cmd: child, name: `${parent.name()} ${child.name()}` } : null
}

describe('README examples match the CLI', async () => {
  const program = buildProgram()
  const found = examples(await readFile(README, 'utf-8'))

  it('finds the examples', () => {
    expect(found.length).toBeGreaterThan(20)
    expect(found).toContain('sessionstat setup --global')
    expect(found).toContain('sessionstat uninstall --global')
  })

  it.each(found)('%s', example => {
    const words = example.split(/\s+/).slice(1)
    const target = resolve(program, words)
    expect(target, `unknown command in "${example}"`).not.toBeNull()
    if (!target) return
    expect(COMMANDS.some(c => c.name === target.name)).toBe(true)
    const flags = new Set(target.cmd.options.flatMap(o => [o.long, o.short]).filter(Boolean))
    for (const flag of example.match(/(?<=\s|\[)--?[a-z][a-z-]*/g) ?? []) {
      expect(flags.has(flag), `${flag} in "${example}"`).toBe(true)
    }
  })
})

describe('install', () => {
  it('is an alias for setup', () => {
    const setup = buildProgram().commands.find(c => c.name() === 'setup')
    expect(setup?.aliases()).toContain('install')
  })
})

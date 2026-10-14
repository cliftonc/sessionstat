import type { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { COMMANDS } from '../src/commands.js'
import { buildProgram } from '../src/program.js'
import { buildSkill } from '../src/skill.js'

/** Every leaf command commander knows, as "template init" for a subcommand. */
function leafCommands(program: Command, prefix = ''): string[] {
  return program.commands.flatMap(c => {
    const name = `${prefix}${c.name()}`
    return c.commands.length > 0 ? leafCommands(c, `${name} `) : [name]
  })
}

describe('the skill cannot drift from the CLI', () => {
  const program = buildProgram()
  const real = leafCommands(program).sort()
  const skill = buildSkill('1.2.3')

  it('documents every command the CLI has, and only those', () => {
    expect(COMMANDS.map(c => c.name).sort()).toEqual(real)
  })

  it('lists every command in the skill, with usage', () => {
    for (const doc of COMMANDS) {
      expect(skill).toContain(`\`${doc.usage}\``)
      expect(doc.usage.startsWith(`sessionstat ${doc.name}`)).toBe(true)
    }
  })

  it('uses the registry text as the CLI help', () => {
    for (const doc of COMMANDS) {
      const [parent, child] = doc.name.split(' ')
      const cmd = program.commands.find(c => c.name() === parent)
      const leaf = child ? cmd?.commands.find(c => c.name() === child) : cmd
      expect(leaf?.description(), doc.name).toBe(doc.summary)
    }
  })

  it('documents every flag a usage line mentions', () => {
    for (const doc of COMMANDS) {
      const [parent, child] = doc.name.split(' ')
      const cmd = program.commands.find(c => c.name() === parent)
      const leaf = child ? cmd?.commands.find(c => c.name() === child) : cmd
      const flags = new Set(leaf?.options.flatMap(o => [o.long, o.short]).filter(Boolean))
      for (const flag of doc.usage.match(/--?[a-z][a-z-]*/g) ?? []) {
        expect(flags.has(flag), `${doc.name} ${flag}`).toBe(true)
      }
    }
  })

  it('has the frontmatter Claude Code needs, and the version', () => {
    expect(skill.startsWith('---\nname: sessionstat\ndescription: ')).toBe(true)
    const description = skill.split('\n')[2]
    for (const phrase of [
      'PR',
      'hide parts',
      'template',
      'notice',
      'why no stats comment',
      'enable or disable',
    ]) {
      expect(description).toContain(phrase)
    }
    expect(skill).toContain('Written by sessionstat 1.2.3.')
  })

  it('covers scopes, templates, config and troubleshooting', () => {
    for (const text of [
      '~/.claude/settings.json',
      '.claude/settings.local.json',
      '<repo>/.sessionstat.md',
      '~/.sessionstat/template.md',
      'sessionstat template vars',
      '`notice`',
      'gh auth status',
      'sessionstat logs',
      'sessionstat show',
      'sessionstat post',
      '+5 minutes',
    ]) {
      expect(skill, text).toContain(text)
    }
  })
})

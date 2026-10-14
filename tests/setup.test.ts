import { chmod, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { paths, projectSettingsPath, repoTemplatePath } from '../src/paths.js'
import type { RunResult } from '../src/runner.js'
import { hasHooksInstalled, installHooks } from '../src/settings.js'
import { runSetup } from '../src/setup.js'
import { installedSkillVersion } from '../src/skill.js'
import { DEFAULT_TEMPLATE } from '../src/template/render.js'
import { runUninstall } from '../src/uninstall.js'
import { failed, fakeRunner, notFound, ok, useTempHome } from './helpers.js'

let env: Awaited<ReturnType<typeof useTempHome>>
let bin: string
let repo: string

const USER_SETTINGS = {
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --check' }] }],
  },
}

beforeEach(async () => {
  env = await useTempHome()
  bin = join(env.home, 'bin', 'sessionstat')
  await mkdir(join(env.home, 'bin'), { recursive: true })
  await writeFile(bin, '#!/bin/sh\n')
  await chmod(bin, 0o755)
  repo = join(env.home, 'work', 'app')
  await mkdir(repo, { recursive: true })
})
afterEach(async () => env.restore())

function runner(opts: { gh?: 'ok' | 'missing' | 'logged-out'; which?: boolean } = {}) {
  const gh = opts.gh ?? 'ok'
  return fakeRunner({
    repos: [{ root: repo, remote: 'https://github.com/acme/app', branch: 'main' }],
    gh: (args): RunResult => {
      if (gh === 'missing') return notFound()
      if (args[0] === '--version') return ok('gh version 2.80.0 (2026-09-01)\n')
      if (args[0] === 'auth')
        return gh === 'ok'
          ? ok()
          : failed('You are not logged into any GitHub hosts. To log in, run: gh auth login')
      return failed('unexpected')
    },
    other: (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sessionstat') {
        return opts.which === false ? failed('', 1) : ok(`${bin}\n`)
      }
      return undefined
    },
  })
}

async function setup(options: { project?: string | boolean } = {}, run = runner()) {
  const lines: string[] = []
  const result = await runSetup(options, {
    run,
    out: l => lines.push(l),
    version: '9.9.9',
    cwd: repo,
    entry: join(env.home, 'bin', 'sessionstat'),
    nodePath: '/usr/local/bin/node',
  })
  return { result, output: lines.join('\n') }
}

const readJson = async (p: string) => JSON.parse(await readFile(p, 'utf-8'))

describe('sessionstat setup (global)', () => {
  it('installs the hooks next to the user’s own and leaves everything else alone', async () => {
    await mkdir(paths.claudeDir(), { recursive: true })
    await writeFile(paths.userSettings(), JSON.stringify(USER_SETTINGS))

    const { result, output } = await setup()
    expect(result.ok).toBe(true)
    expect(result.settingsPath).toBe(paths.userSettings())
    expect(result.hookCommand).toBe(`${bin} hook`)

    const settings = await readJson(paths.userSettings())
    expect(settings.permissions).toEqual(USER_SETTINGS.permissions)
    expect(settings.hooks.PreToolUse).toEqual(USER_SETTINGS.hooks.PreToolUse)
    expect(settings.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'say done' }] },
      { hooks: [{ type: 'command', command: `${bin} hook`, timeout: 10 }] },
    ])
    expect(settings.hooks.PostToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: `${bin} hook`, timeout: 10 }] },
    ])
    expect(Object.keys(settings.hooks).sort()).toEqual(
      ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop'].sort()
    )

    expect(output).toContain('✓ git is installed')
    expect(output).toContain('✓ gh is logged in')
    expect(output).toContain('✓ Hook command resolves')
    expect(output).toContain(`✓ Hooks installed in ${paths.userSettings()}`)
    expect(output).toContain('✓ Existing settings and hooks untouched')
    expect(output).toContain(`✓ Claude skill installed at ${paths.skillFile()}`)
    expect(output).toContain('All set.')
  })

  it('is idempotent', async () => {
    await setup()
    const first = await readFile(paths.userSettings(), 'utf-8')
    await setup()
    expect(await readFile(paths.userSettings(), 'utf-8')).toBe(first)
  })

  it('copies the default template once and never overwrites it', async () => {
    const { output } = await setup()
    expect(await readFile(paths.homeTemplate(), 'utf-8')).toBe(DEFAULT_TEMPLATE)
    expect(output).toContain(`Template written to ${paths.homeTemplate()}`)
    expect(output).toContain('`sessionstat template vars` shows the fields')

    await writeFile(paths.homeTemplate(), 'MINE')
    const again = await setup()
    expect(await readFile(paths.homeTemplate(), 'utf-8')).toBe('MINE')
    expect(again.output).toContain(`Template kept: ${paths.homeTemplate()}`)
  })

  it('installs the skill, overwriting it and stamping the version', async () => {
    await mkdir(paths.skillDir(), { recursive: true })
    await writeFile(paths.skillFile(), 'stale')
    await setup()
    const skill = await readFile(paths.skillFile(), 'utf-8')
    expect(skill.startsWith('---\nname: sessionstat\n')).toBe(true)
    expect(await installedSkillVersion()).toBe('9.9.9')
  })

  it('without gh: says how to fix it, fails, but still installs the hooks', async () => {
    const { result, output } = await setup({}, runner({ gh: 'missing' }))
    expect(result.ok).toBe(false)
    expect(output).toContain('✗ GitHub CLI (gh) is not installed')
    expect(output).toContain('fix: brew install gh')
    expect(output).toContain('fix: gh auth login')
    expect(await hasHooksInstalled(paths.userSettings())).toBe(true)
  })

  it('logged out of gh: says gh auth login and fails', async () => {
    const { result, output } = await setup({}, runner({ gh: 'logged-out' }))
    expect(result.ok).toBe(false)
    expect(output).toContain('✗ gh is not logged in')
    expect(output).toContain('fix: gh auth login')
    expect(await hasHooksInstalled(paths.userSettings())).toBe(true)
  })

  it('falls back to node + the script when sessionstat is not on PATH', async () => {
    const { result } = await setup({}, runner({ which: false }))
    expect(result.hookCommand).toBe(`/usr/local/bin/node ${await realpath(bin)} hook`)
    expect(result.ok).toBe(true)
  })

  it('refuses to touch a settings file it cannot parse', async () => {
    await mkdir(paths.claudeDir(), { recursive: true })
    await writeFile(paths.userSettings(), '{ not json')
    const { result, output } = await setup()
    expect(result.ok).toBe(false)
    expect(output).toContain('refusing to overwrite it')
    expect(await readFile(paths.userSettings(), 'utf-8')).toBe('{ not json')
  })

  it('cleans our hooks out of the dead user-level settings.local.json', async () => {
    await installHooks(paths.legacyUserSettings(), `${bin} hook`)
    const { output } = await setup()
    expect(await hasHooksInstalled(paths.legacyUserSettings())).toBe(false)
    expect(output).toContain(`Removed stale hooks from ${paths.legacyUserSettings()}`)
  })

  it('warns when a project install already exists', async () => {
    await setup({ project: true })
    const { output } = await setup()
    expect(output).toContain(`! Also installed in ${projectSettingsPath(repo)}`)
  })
})

describe('sessionstat setup --project', () => {
  it('installs into the repository’s settings.local.json, not the global file', async () => {
    const { result, output } = await setup({ project: join(repo, 'src') })
    expect(result.ok).toBe(true)
    expect(result.settingsPath).toBe(projectSettingsPath(repo))
    expect(await hasHooksInstalled(projectSettingsPath(repo))).toBe(true)
    await expect(stat(paths.userSettings())).rejects.toThrow()
    expect((await loadConfig()).projectInstalls).toEqual([repo])
    expect(output).toContain(`Template written to ${repoTemplatePath(repo)}`)
  })

  it('copies the template into the repository, never over an existing one', async () => {
    await writeFile(repoTemplatePath(repo), 'TEAM TEMPLATE')
    await setup({ project: true })
    expect(await readFile(repoTemplatePath(repo), 'utf-8')).toBe('TEAM TEMPLATE')
    await expect(stat(paths.homeTemplate())).rejects.toThrow()
  })

  it('still installs the skill globally', async () => {
    await setup({ project: true })
    expect(await installedSkillVersion()).toBe('9.9.9')
  })

  it('warns when the global install exists too', async () => {
    await setup()
    const { output } = await setup({ project: true })
    expect(output).toContain(`! Also installed globally (${paths.userSettings()})`)
    expect(output).toContain('de-duplicates')
  })

  it('fails outside a git repository', async () => {
    const { result, output } = await setup({ project: env.home })
    expect(result.ok).toBe(false)
    expect(output).toContain('is not inside a git repository')
  })
})

describe('sessionstat uninstall', () => {
  async function uninstall(options: { project?: string | boolean } = {}) {
    const lines: string[] = []
    const result = await runUninstall(options, {
      run: runner(),
      out: l => lines.push(l),
      cwd: repo,
    })
    return { result, output: lines.join('\n') }
  }

  it('leaves only the user’s own hooks, and removes the skill', async () => {
    await mkdir(paths.claudeDir(), { recursive: true })
    await writeFile(paths.userSettings(), JSON.stringify(USER_SETTINGS))
    await setup()
    const { result } = await uninstall()
    expect(result.removedFrom).toEqual([paths.userSettings()])
    expect(result.skillRemoved).toBe(true)
    const settings = await readJson(paths.userSettings())
    expect(settings).toEqual(USER_SETTINGS)
    await expect(stat(paths.skillFile())).rejects.toThrow()
    // The template the user may have edited is kept.
    expect(await readFile(paths.homeTemplate(), 'utf-8')).toBe(DEFAULT_TEMPLATE)
  })

  it('keeps the skill while another scope still has hooks', async () => {
    await setup()
    await setup({ project: true })

    const global = await uninstall()
    expect(global.result.skillRemoved).toBe(false)
    expect(global.result.stillInstalled).toEqual([projectSettingsPath(repo)])
    expect(global.output).toContain('The Claude skill is kept')
    expect(await installedSkillVersion()).toBe('9.9.9')

    const project = await uninstall({ project: true })
    expect(project.result.removedFrom).toEqual([projectSettingsPath(repo)])
    expect(project.result.skillRemoved).toBe(true)
    expect((await loadConfig()).projectInstalls).toEqual([])
  })
})

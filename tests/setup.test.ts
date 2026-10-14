import { chmod, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { paths, projectSettingsPath, repoTemplatePath } from '../src/paths.js'
import type { RunResult } from '../src/runner.js'
import { hasHooksInstalled, installHooks } from '../src/settings.js'
import { NOT_IN_REPO, type SetupOptions, runSetup } from '../src/setup.js'
import { installedSkillVersion } from '../src/skill.js'
import { runStatus } from '../src/status.js'
import { DEFAULT_TEMPLATE } from '../src/template/render.js'
import { type UninstallOptions, runUninstall } from '../src/uninstall.js'
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

async function setup(options: SetupOptions = {}, run = runner(), cwd = repo) {
  const lines: string[] = []
  const result = await runSetup(options, {
    run,
    out: l => lines.push(l),
    version: '9.9.9',
    cwd,
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

    const { result, output } = await setup({ global: true })
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
    await setup({ global: true })
    const first = await readFile(paths.userSettings(), 'utf-8')
    await setup({ global: true })
    expect(await readFile(paths.userSettings(), 'utf-8')).toBe(first)
  })

  it('copies the default template once and never overwrites it', async () => {
    const { output } = await setup({ global: true })
    expect(await readFile(paths.homeTemplate(), 'utf-8')).toBe(DEFAULT_TEMPLATE)
    expect(output).toContain(`Template written to ${paths.homeTemplate()}`)
    expect(output).toContain('`sessionstat template vars` shows the fields')

    await writeFile(paths.homeTemplate(), 'MINE')
    const again = await setup({ global: true })
    expect(await readFile(paths.homeTemplate(), 'utf-8')).toBe('MINE')
    expect(again.output).toContain(`Template kept: ${paths.homeTemplate()}`)
  })

  it('installs the skill, overwriting it and stamping the version', async () => {
    await mkdir(paths.skillDir(), { recursive: true })
    await writeFile(paths.skillFile(), 'stale')
    await setup({ global: true })
    const skill = await readFile(paths.skillFile(), 'utf-8')
    expect(skill.startsWith('---\nname: sessionstat\n')).toBe(true)
    expect(await installedSkillVersion()).toBe('9.9.9')
  })

  it('without gh: says how to fix it, fails, but still installs the hooks', async () => {
    const { result, output } = await setup({ global: true }, runner({ gh: 'missing' }))
    expect(result.ok).toBe(false)
    expect(output).toContain('✗ GitHub CLI (gh) is not installed')
    expect(output).toContain('fix: brew install gh')
    expect(output).toContain('fix: gh auth login')
    expect(await hasHooksInstalled(paths.userSettings())).toBe(true)
  })

  it('logged out of gh: says gh auth login and fails', async () => {
    const { result, output } = await setup({ global: true }, runner({ gh: 'logged-out' }))
    expect(result.ok).toBe(false)
    expect(output).toContain('✗ gh is not logged in')
    expect(output).toContain('fix: gh auth login')
    expect(await hasHooksInstalled(paths.userSettings())).toBe(true)
  })

  it('falls back to node + the script when sessionstat is not on PATH', async () => {
    const { result } = await setup({ global: true }, runner({ which: false }))
    expect(result.hookCommand).toBe(`/usr/local/bin/node ${await realpath(bin)} hook`)
    expect(result.ok).toBe(true)
  })

  it('refuses to touch a settings file it cannot parse', async () => {
    await mkdir(paths.claudeDir(), { recursive: true })
    await writeFile(paths.userSettings(), '{ not json')
    const { result, output } = await setup({ global: true })
    expect(result.ok).toBe(false)
    expect(output).toContain('refusing to overwrite it')
    expect(await readFile(paths.userSettings(), 'utf-8')).toBe('{ not json')
  })

  it('cleans our hooks out of the dead user-level settings.local.json', async () => {
    await installHooks(paths.legacyUserSettings(), `${bin} hook`)
    const { output } = await setup({ global: true })
    expect(await hasHooksInstalled(paths.legacyUserSettings())).toBe(false)
    expect(output).toContain(`Removed stale hooks from ${paths.legacyUserSettings()}`)
  })

  it('says it runs in every repository', async () => {
    const { result, output } = await setup({ global: true })
    expect(result.settingsPath).toBe(paths.userSettings())
    expect(output).toContain('Installed globally: runs in every repository.')
    await expect(stat(projectSettingsPath(repo))).rejects.toThrow()
  })

  it('works outside a git repository', async () => {
    const { result } = await setup({ global: true }, runner(), env.home)
    expect(result.ok).toBe(true)
    expect(await hasHooksInstalled(paths.userSettings())).toBe(true)
  })

  it('warns when a project install already exists', async () => {
    await setup()
    const { output } = await setup({ global: true })
    expect(output).toContain(`! Also installed in ${projectSettingsPath(repo)}`)
    expect(output).toContain(`sessionstat uninstall ${repo}`)
  })

  it('takes no path', async () => {
    const { result, output } = await setup({ global: true, path: repo })
    expect(result.ok).toBe(false)
    expect(output).toContain('takes no path')
    await expect(stat(paths.userSettings())).rejects.toThrow()
  })
})

describe('sessionstat setup (per repository, the default)', () => {
  it('with no flag, installs into this repository only', async () => {
    const { result, output } = await setup()
    expect(result.ok).toBe(true)
    expect(result.settingsPath).toBe(projectSettingsPath(repo))
    expect(await hasHooksInstalled(projectSettingsPath(repo))).toBe(true)
    await expect(stat(paths.userSettings())).rejects.toThrow()
    expect((await loadConfig()).projectInstalls).toEqual([repo])
    expect(output).toContain(`Template written to ${repoTemplatePath(repo)}`)
    expect(output).toContain(`Installed for ${repo} only.`)
  })

  it('installs into the repository containing a path', async () => {
    const { result } = await setup({ path: join(repo, 'src') }, runner(), env.home)
    expect(result.settingsPath).toBe(projectSettingsPath(repo))
    await expect(stat(paths.userSettings())).rejects.toThrow()
  })

  it('copies the template into the repository, never over an existing one', async () => {
    await writeFile(repoTemplatePath(repo), 'TEAM TEMPLATE')
    await setup()
    expect(await readFile(repoTemplatePath(repo), 'utf-8')).toBe('TEAM TEMPLATE')
    await expect(stat(paths.homeTemplate())).rejects.toThrow()
  })

  it('still installs the skill globally', async () => {
    await setup()
    expect(await installedSkillVersion()).toBe('9.9.9')
  })

  it('warns when the global install exists too, and says how to drop it', async () => {
    await setup({ global: true })
    const { output } = await setup()
    expect(output).toContain(`! Also installed globally (${paths.userSettings()})`)
    expect(output).toContain('runs in every repository')
    expect(output).toContain('de-duplicates')
    expect(output).toContain('fix: sessionstat uninstall --global')
  })

  it('outside a git repository: refuses, and installs nothing anywhere', async () => {
    const { result, output } = await setup({}, runner(), env.home)
    expect(result.ok).toBe(false)
    expect(output).toContain(NOT_IN_REPO)
    expect(output).toContain('use --global to install everywhere')
    await expect(stat(paths.userSettings())).rejects.toThrow()
    await expect(stat(paths.skillFile())).rejects.toThrow()
  })

  it('fails for a path outside a git repository', async () => {
    const { result, output } = await setup({ path: env.home })
    expect(result.ok).toBe(false)
    expect(output).toContain(`${env.home}: ${NOT_IN_REPO}`)
  })
})

describe('sessionstat uninstall', () => {
  async function uninstall(options: UninstallOptions = {}, cwd = repo) {
    const lines: string[] = []
    const result = await runUninstall(options, {
      run: runner(),
      out: l => lines.push(l),
      cwd,
    })
    return { result, output: lines.join('\n') }
  }

  it('leaves only the user’s own hooks, and removes the skill', async () => {
    await mkdir(paths.claudeDir(), { recursive: true })
    await writeFile(paths.userSettings(), JSON.stringify(USER_SETTINGS))
    await setup({ global: true })
    const { result } = await uninstall({ global: true })
    expect(result.removedFrom).toEqual([paths.userSettings()])
    expect(result.skillRemoved).toBe(true)
    const settings = await readJson(paths.userSettings())
    expect(settings).toEqual(USER_SETTINGS)
    await expect(stat(paths.skillFile())).rejects.toThrow()
    // The template the user may have edited is kept.
    expect(await readFile(paths.homeTemplate(), 'utf-8')).toBe(DEFAULT_TEMPLATE)
  })

  it('keeps the skill while another scope still has hooks', async () => {
    await setup({ global: true })
    await setup()

    const global = await uninstall({ global: true })
    expect(global.result.skillRemoved).toBe(false)
    expect(global.result.stillInstalled).toEqual([projectSettingsPath(repo)])
    expect(global.output).toContain('The Claude skill is kept')
    expect(await installedSkillVersion()).toBe('9.9.9')

    const project = await uninstall()
    expect(project.result.removedFrom).toEqual([projectSettingsPath(repo)])
    expect(project.result.skillRemoved).toBe(true)
    expect((await loadConfig()).projectInstalls).toEqual([])
  })

  it('defaults to this repository and leaves the global hooks alone', async () => {
    await setup({ global: true })
    await setup()
    const { result, output } = await uninstall()
    expect(result.ok).toBe(true)
    expect(result.removedFrom).toEqual([projectSettingsPath(repo)])
    expect(await hasHooksInstalled(paths.userSettings())).toBe(true)
    expect(output).toContain(`Removed the install for ${repo}.`)
    expect(output).toContain('The global install remains')
    expect(output).toContain('sessionstat uninstall --global')
    expect(result.skillRemoved).toBe(false)
  })

  it('with --global, removes only the global hooks', async () => {
    await setup({ global: true })
    await setup()
    const { result, output } = await uninstall({ global: true })
    expect(result.removedFrom).toEqual([paths.userSettings()])
    expect(await hasHooksInstalled(projectSettingsPath(repo))).toBe(true)
    expect(output).toContain('Removed the global install.')
  })

  it('outside a git repository without --global: refuses and removes nothing', async () => {
    await setup({ global: true })
    const { result, output } = await uninstall({}, env.home)
    expect(result.ok).toBe(false)
    expect(output).toContain('Not inside a git repository')
    expect(output).toContain('--global')
    expect(await hasHooksInstalled(paths.userSettings())).toBe(true)
  })
})

describe('sessionstat status', () => {
  async function status(cwd = repo) {
    const lines: string[] = []
    const run = runner()
    const wrapped = (async (cmd, args, options) =>
      cmd === 'gh' && args[0] === 'auth' ? ok() : run(cmd, args, options)) as typeof run
    await runStatus({ run: wrapped, out: l => lines.push(l), cwd })
    return lines.join('\n')
  }

  it('reports a per-repository install', async () => {
    await setup()
    const output = await status()
    expect(output).toContain('scope    this repository only')
    expect(output).toContain(`repo     yes (${projectSettingsPath(repo)}`)
    expect(output).toContain('global   no')
    expect(output).not.toContain('global install: runs in every repository')
  })

  it('flags a global install prominently', async () => {
    await setup({ global: true })
    const output = await status()
    expect(output).toContain('scope    global (covers this repository)')
    expect(output).toContain(`! global install: runs in every repository (${paths.userSettings()})`)
    expect(output).toContain('repo     no (sessionstat setup)')
  })

  it('reports both scopes', async () => {
    await setup({ global: true })
    await setup()
    const output = await status()
    expect(output).toContain('scope    this repository and global')
    expect(output).toContain('! global install: runs in every repository')
  })

  it('says when nothing covers this repository', async () => {
    expect(await status()).toContain('scope    not installed for this repository')
  })
})

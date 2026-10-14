/**
 * Every user-facing command, once. `cli.ts` takes its descriptions from here and the skill's
 * command list is generated from here, so the two cannot drift; a test checks that every
 * entry is a real command and every real command has an entry.
 */
export interface CommandDoc {
  /** As registered with commander (`template init` for a subcommand). */
  name: string
  /** How to call it, flags included. */
  usage: string
  summary: string
}

export const COMMANDS: CommandDoc[] = [
  {
    name: 'setup',
    usage: 'sessionstat setup [path] [--global]',
    summary:
      '(alias: install) Install the Claude Code hooks into the repository containing path (default: here) — or into every repository only with --global — plus the default template and the Claude skill, and check gh, git and the hook command',
  },
  {
    name: 'uninstall',
    usage: 'sessionstat uninstall [path] [--global]',
    summary:
      'Remove the hooks from the repository containing path (default: here), or the global hooks with --global; the skill goes too once no scope has hooks left',
  },
  {
    name: 'status',
    usage: 'sessionstat status',
    summary:
      'Which install scopes cover this repository (and whether a global install runs everywhere), gh login, the template in effect, recorded sessions, queued PR checks and the last error',
  },
  {
    name: 'show',
    usage: 'sessionstat show [--all] [--transcript <file...>] [--no-pr]',
    summary:
      'Print the comment for the current branch without posting it; --all merges in every sessionstat comment on the PR, from every author',
  },
  {
    name: 'post',
    usage: 'sessionstat post [--force]',
    summary: 'Post or update the comment on the current branch’s PR now',
  },
  {
    name: 'template init',
    usage: 'sessionstat template init [--repo] [--force]',
    summary:
      'Write the default template to ~/.sessionstat/template.md, or <repo>/.sessionstat.md with --repo, to edit',
  },
  {
    name: 'template vars',
    usage: 'sessionstat template vars [--all] [--transcript <file...>] [--no-pr]',
    summary: 'Print the data passed to the template for the current branch, as JSON',
  },
  {
    name: 'enable',
    usage: 'sessionstat enable [--global]',
    summary:
      'Turn sessionstat back on for this repository (or everywhere it is installed with --global); this is an on/off switch, not an install',
  },
  {
    name: 'disable',
    usage: 'sessionstat disable [--global]',
    summary:
      'Stop recording and posting for this repository (or everywhere it is installed with --global), without uninstalling',
  },
  {
    name: 'config',
    usage: 'sessionstat config [notice on|off]',
    summary:
      'Show the settings in ~/.sessionstat/config.json, or turn the start-of-session notice on or off',
  },
  {
    name: 'logs',
    usage: 'sessionstat logs [-n <lines>] [--errors]',
    summary: 'Print the end of ~/.sessionstat/sessionstat.log',
  },
  {
    name: 'hook',
    usage: 'sessionstat hook',
    summary: 'Internal: what the Claude Code hooks run (reads the hook JSON on stdin)',
  },
]

export function commandDoc(name: string): string {
  const doc = COMMANDS.find(c => c.name === name)
  if (!doc) throw new Error(`No command doc for ${name}`)
  return doc.summary
}

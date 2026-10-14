import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { COMMANDS } from './commands.js'
import { paths } from './paths.js'

/**
 * The global Claude Code skill, after guidemode's `skill.ts`: so Claude knows what sessionstat
 * does and can configure it for the user. It is ours, so setup overwrites it every time, and it
 * carries the version that wrote it.
 */

export function buildSkill(version: string): string {
  const commands = COMMANDS.map(c => `- \`${c.usage}\` — ${c.summary}`).join('\n')
  return `---
name: sessionstat
description: Explain and configure sessionstat, which posts Claude Code session stats as a comment on the GitHub pull request for the current branch. Use when the user asks about the sessionstat PR comment or session stats on a PR, wants to change, reorder or hide parts of the sessionstat comment or edit the sessionstat template, asks about the "sessionstat:" notice shown at the start of a session, asks why no stats comment appeared on a PR, or wants to enable or disable sessionstat globally or for a repository.
---

<!-- Written by sessionstat ${version}. Overwritten by \`sessionstat setup\`; do not edit. -->

# sessionstat

sessionstat posts **one** comment on the pull request for the branch you are working on, with
stats for the Claude Code sessions that built it: duration, prompts, tool calls, files edited,
tokens, cost, errors, interruptions, compactions and test runs. It uses the user's own \`gh\`
login. Nothing is sent anywhere except GitHub, and no prompt text is posted.

## How it works, end to end

1. **Hooks.** \`sessionstat setup\` adds hooks to Claude Code settings for \`SessionStart\`,
   \`Stop\`, \`PostToolUse\` (Bash only) and \`SessionEnd\`. Each runs \`sessionstat hook\`, which
   reads the hook JSON from stdin and returns at once; anything slow runs in a detached worker.
2. **Scratch.** The hook records the session in \`~/.sessionstat/sessions/<sessionId>.json\`:
   transcript path, repository root, remote and every branch it was seen on.
3. **Finding the PR.** On \`Stop\`, \`SessionStart\`, and a Bash \`git push\` or \`gh pr create\`,
   a worker runs \`gh pr view --json number,url,headRefName\` for the branch. Only an open PR counts.
4. **Posting.** The worker parses the transcripts of every recorded session on that repo and
   branch, renders the template, and creates the comment or edits it (\`gh api\` PATCH). Each
   person gets their own comment: ours is the one with the \`<!-- sessionstat -->\` marker
   written by the current \`gh\` user, so a second contributor never edits (or fails to edit)
   someone else's. If nothing has changed, nothing is written.
   - Every comment ends with a hidden \`<!-- sessionstat:data {...} -->\` block holding the raw
     numbers. It is the PR's persisted state: before an update it is read back and merged with
     the local sessions (local wins; sessions only in the block, e.g. from another machine, are
     kept), so a comment never loses a session. \`sessionstat show --all\` merges every
     contributor's block.
   - Sessions are split into **build** (started before the PR was opened) and **follow-up**
     (started after: review responses). This is recorded at SessionStart; commits made during a
     session are recorded at each \`Stop\`.
5. **After the session ends.** People usually open the PR after the agent finishes, so
   \`SessionEnd\` queues checks at +5 minutes, +30 minutes and +2 hours in
   \`~/.sessionstat/pr-checks/\` and starts a background poller (only one runs at a time). Every
   hook run, in any repository, also catches up checks that are overdue, so a poller killed by
   a reboot is caught up the next time Claude Code is used. After the last check it gives up;
   \`sessionstat post\` posts at any time.

## Commands

${commands}

## Install scopes

- **One repository** (the default): \`sessionstat setup [path]\` installs into the repository
  containing \`path\` (default: the working directory). Hooks go in
  \`<repo>/.claude/settings.local.json\`, and the default template is copied to
  \`<repo>/.sessionstat.md\` if there is none. Run outside a git repository, setup refuses
  rather than installing globally.
- **Global**, only when asked: \`sessionstat setup --global\` puts the hooks in
  \`~/.claude/settings.json\`, so they run in **every** repository. Never suggest it unless
  the user wants that.
- \`sessionstat uninstall\` mirrors setup: this repository by default, \`--global\` for the
  global hooks. \`sessionstat status\` shows which scopes cover the current repository and
  flags a global install.
- Installed in both, each event fires twice; sessionstat de-duplicates them, and setup warns
  and suggests \`sessionstat uninstall --global\` for a per-repository-only setup.
- \`--project\` is a deprecated alias for the default and prints a warning.
- \`enable\` / \`disable --global\` are different: an on/off switch for every repository where
  sessionstat is installed. They never install or remove hooks.
- The skill is always global (\`~/.claude/skills/sessionstat/SKILL.md\`). Session scratch, the
  check queue, logs and config always live in \`~/.sessionstat/\`.

## The comment template

The comment is a [Mustache](https://mustache.github.io/mustache.5.html) template. First match wins:

1. \`<repo>/.sessionstat.md\` — per repository (can be committed, so the team shares it)
2. \`~/.sessionstat/template.md\` — the user's own default
3. the template built into sessionstat

\`sessionstat template init\` (or \`--repo\`) writes the default out to edit, and
\`sessionstat template vars\` prints every field available for the current branch. Numbers
arrive pre-formatted (\`"1h 12m"\`, \`"$3.41"\`, \`"1.2M"\`); flags like \`multipleSessions\`,
\`hasCost\`, \`hasTests\` and \`hasErrors\` exist to show or hide sections.

Each section of the default template is one \`{{#…}}…{{/…}}\` block. To hide one, delete the
block. For example, to drop the tokens line, remove:

\`\`\`mustache
{{#totals}}
**Tokens:** {{tokens.input}} in · {{tokens.output}} out · …
{{/totals}}
\`\`\`

Preview with \`sessionstat show\` before anything is posted. The \`<!-- sessionstat -->\` marker
and the hidden data block are always added by sessionstat, so a template cannot break updating
the comment. Useful view fields: \`totals\`, \`sessions\`, \`buildSessions\` /
\`followUpSessions\` (with \`hasBuild\` / \`hasFollowUp\`), and per session \`commits\`. A template
that fails to parse is logged and the default is used instead.

## Configuration: \`~/.sessionstat/config.json\`

| Key | Default | Meaning |
|---|---|---|
| \`notice\` | \`true\` | Show the "sessionstat: stats for this session will be added to the PR for …" line at the start of a session. \`sessionstat config notice off\` sets it to \`false\` |
| \`enabled\` | \`true\` | \`false\` turns sessionstat off everywhere (\`sessionstat disable --global\`) |
| \`disabledRepos\` | \`[]\` | Repository roots where it is off (\`sessionstat disable\` inside the repo) |
| \`projectInstalls\` | \`[]\` | Repositories with a project-scope install, kept by setup |

## Troubleshooting: "no stats comment on my PR"

1. \`sessionstat status\` — is it installed for this repository (or globally), is \`gh\`
   logged in, is the repo disabled, which sessions are recorded for this branch, which checks
   are queued, last error.
2. \`gh auth status\` — sessionstat posts as this user; it needs \`repo\` access to comment.
3. \`sessionstat logs\` (or \`--errors\`) — what the background workers did.
4. \`sessionstat show\` — render the comment locally; if this is empty, no session was recorded
   on this branch (sessions are only recorded in git repositories, on a branch).
5. \`sessionstat post\` — post now, rather than waiting for the next hook or check.

The PR must be **open** and its head must be the branch the session worked on.
`
}

export async function installSkill(version: string): Promise<string> {
  await mkdir(paths.skillDir(), { recursive: true })
  await writeFile(paths.skillFile(), buildSkill(version), { mode: 0o644 })
  return paths.skillFile()
}

export async function removeSkill(): Promise<boolean> {
  try {
    await readFile(paths.skillFile())
  } catch {
    return false
  }
  await rm(paths.skillDir(), { recursive: true, force: true })
  return true
}

/** The version stamped in the installed skill, or null if it is not installed. */
export async function installedSkillVersion(): Promise<string | null> {
  try {
    const content = await readFile(paths.skillFile(), 'utf-8')
    return content.match(/Written by sessionstat (\S+)\./)?.[1] ?? 'unknown'
  } catch {
    return null
  }
}

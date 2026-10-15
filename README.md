# sessionstat

Claude Code session stats on your pull requests, with no account and no server.

`sessionstat` installs Claude Code hooks. When the branch you are working on has a pull request,
it posts **one** comment on it, and keeps that comment up to date, with stats for the agent
sessions that built it: duration, prompts, tool calls, files edited, tokens, cost, errors,
interruptions, compactions and test runs. It posts with your own `gh` login. Nothing is sent
anywhere except GitHub, and no prompt text is posted.

What the comment looks like:

> ### Claude Code · 3 sessions · 1h 59m
>
> | Time | Prompts | Tool calls | Files | Commits | Tokens | Billed | API value |
> |:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
> | **1h 59m** | **47** | **375** | **33** | **9** | **24.9M** | **$1.10<br><sub>+ plan</sub>** | **$48.15** |
>
> <details open>
> <summary><b>Sessions</b> · 2 build, 1 follow-up · Oct 14 09:00 to Oct 15 10:32 UTC</summary>
>
> #### Activity
>
> | Session | Time | Oct 14 09:00 → Oct 15 10:32 | Prompts | Tools | Files | Commits |
> |---|--:|---|--:|--:|--:|--:|
> | **Build** | | | | | | |
> | `a1b2c3d4` alice | 42m | `███··················\|\|·` | 18 | 143 | 12 | 3 |
> | `b4e5f6a7` alice | 1h 5m | `················▐████\|\|·` | 25 | 210 | 19 | 5 |
> | **Follow-up** | | | | | | |
> | `c7d8e9f0` bob | 12m | `·····················\|\|█` | 4 | 22 | 3 | 1 |
>
> #### Tokens and cost
>
> | Session | Model | Input | Output | Cache read | Cache write | Tokens | Billed | API value |
> |---|---|--:|--:|--:|--:|--:|--:|--:|
> | **Build** | | | | | | | | |
> | `a1b2c3d4` alice | Opus 5.5 | 24k | 310k | 8.4M | 610k | 9.3M | plan | $18.20 |
> | `b4e5f6a7` alice | Opus 5.5 | 31k | 450k | 12.9M | 880k | 14.3M | plan | $27.90 |
> | **Follow-up** | | | | | | | | |
> | `c7d8e9f0` bob | Sonnet 5.5 | 6k | 48k | 1.1M | 120k | 1.3M | $1.10 | $2.05 |
> | **Total** | | **61k** | **808k** | **22.4M** | **1.6M** | **24.9M** | **$1.10<br><sub>+ plan</sub>** | **$48.15** |
>
> <sub>Build: before the PR was opened; follow-up: after. Timeline: real time, each character ≈ 15 min; <code>\|\|</code> is a break of more than 4h left out. Billed "plan": covered by a Claude subscription.</sub>
>
> </details>
>
> **Quality** · 95% tool success · tests: 12 passed, **1 failed** · tool errors: 21 · interruptions: 2 · compactions: 1
>
> <sub>Posted by [sessionstat](https://www.npmjs.com/package/sessionstat) · updated 2026-10-15 10:40 UTC</sub>

With one session, the tables under the headline collapse to a single row: who, the model, when it
started and the token split.

## Install

Requires Node.js 24 or later, `git`, and the [GitHub CLI](https://cli.github.com/), logged in.

```bash
npm install -g sessionstat         # or, from a checkout: pnpm install && pnpm build && pnpm link --global
brew install gh && gh auth login   # if you do not have gh yet

cd path/to/your/repo
sessionstat setup                  # this repository only; repeat in each repository you want
                                   # (`sessionstat install` is the same command)
```

**sessionstat is per repository.** `sessionstat setup [path]` installs into the repository
containing `path` (default: the current directory) and nowhere else, so run it in each
repository whose PRs should get a stats comment. Outside a git repository it refuses rather than
falling back to a global install:

```
sessionstat: Not inside a git repository. Run it in the repo you want, or use --global to install everywhere
```

`setup` checks that `git` and `gh` are installed, that `gh` is logged in and that the hook
command resolves; it writes the hooks and reads the settings back to confirm both that they are
there and that your own hooks are untouched; it installs a Claude Code skill so Claude can explain and configure sessionstat for you; and it ends
with a ✓/✗ checklist and one line saying where it installed (`Installed for /path/to/repo
only.`). If `gh` is missing or logged out it prints the fix and exits non-zero, but the hooks
are installed anyway.

Run in a terminal, it walks you through the optional parts, each defaulting to no:

```
Post session stats for everyone working in /path/to/repo (writes .claude/settings.json, to commit)? [y/N]
Also keep these stats as fields on a GitHub Projects board for acme/app, to chart them across PRs? [y/N]
Share the board setting with everyone in acme/app (writes .claude/sessionstat.json, to commit)? [y/N]
Customise the comment template? [y/N]
```

Flags answer them without asking (and nothing is asked without a terminal):
`--team`, `--project-board <url|create>` / `--no-project-board`, `--share-board` and
`--template repo|home|none`. Say no to everything and the only file written in the repository
is your own `.claude/settings.local.json`.

### For the whole team: `--team`

```bash
sessionstat setup --team
```

puts the hooks in `.claude/settings.json`, which you commit, so sessionstat runs for everyone
who works in the repository. The hook command there cannot name a path on your machine, so it
runs `node_modules/.bin/sessionstat` if the repository has sessionstat as a dependency (pin it
with `npm install -D sessionstat`), else `sessionstat` from PATH, and otherwise does nothing:
teammates without it see no errors. It does not use `npx`, which would add seconds to every
hook. Each teammate posts with their own `gh` login. `sessionstat uninstall --team` removes it.

### Every repository: `--global`, only if you mean it

```bash
sessionstat setup --global
```

> **Warning:** a global install records **every** Claude Code session in **every** git
> repository on this machine, and posts stats to the PR of any of them that has one: work,
> personal and client repositories alike. Prefer `sessionstat setup` in the repositories you
> choose. `sessionstat status` always says when a global install is active.

Setup prints `Installed globally: runs in every repository.` for this scope. To keep it but
silence one repository, `sessionstat disable` in that repository.

### Where things live

| | Just you (default) | Shared with the team (opt-in, committed) |
|---|---|---|
| Hooks | `<repo>/.claude/settings.local.json` (or `~/.claude/settings.json` with `--global`) | `<repo>/.claude/settings.json` (`--team`) |
| Project board setting | `~/.sessionstat/config.json` | `<repo>/.claude/sessionstat.json` (`--share-board`, `board setup --repo`) |
| Template | built in; `~/.sessionstat/template.md` if you write one out | `<repo>/.claude/sessionstat.md` (`template init --repo`) |
| Claude skill | `~/.claude/skills/sessionstat/SKILL.md` | |
| Sessions, check queue, config, logs | `~/.sessionstat/` | |

`settings.local.json` is Claude Code's personal settings file for a repository, meant to stay
out of git, so a per-repository install is yours alone (check it is in your `.gitignore` if
Claude Code did not create it first). Nothing sessionstat-specific goes in the repository's
root; files from older versions there (`.sessionstat.md`, `.sessionstat.json`) are still read,
and can be moved into `.claude/` as `sessionstat.md` and `sessionstat.json`. The skill is
documentation for Claude, so it is always global, and it is removed once no scope has hooks
left.

Installed in both scopes, each event fires twice; sessionstat de-duplicates them, and `setup`
warns you and suggests `sessionstat uninstall --global` if you only want it per repository.
`--project [path]`, from before per-repository was the default, still works as a hidden,
deprecated alias for it.

### Uninstall

```bash
sessionstat uninstall            # this repository's hooks (or: sessionstat uninstall path/to/repo)
sessionstat uninstall --global   # the global hooks
```

Each removes the hooks from that scope and nothing else, and says if another scope still has
them. Templates, recorded sessions and logs are kept.

### Moving from the old global default

Earlier versions installed globally by default. To switch to per repository:

```bash
sessionstat status               # "! global install: runs in every repository" if you have one
sessionstat uninstall --global
cd path/to/your/repo && sessionstat setup   # in each repository you want
```

## How it works

1. **Hooks.** `SessionStart`, `Stop`, `PostToolUse` (Bash only) and `SessionEnd` run
   `sessionstat hook`. It reads the hook JSON from stdin, writes a small record and returns in
   tens of milliseconds; anything slow runs in a detached background worker.
2. **Scratch.** Each session is recorded in `~/.sessionstat/sessions/<sessionId>.json`:
   transcript path, repository root, remote, every branch it was seen on, whether a PR already
   existed when it started, and the commits made during it. No stats are stored: they are
   computed from the Claude Code transcript, which is already on disk, at the moment of posting.
3. **Finding the PR.** On `Stop`, on `SessionStart`, after a Bash `git push` or `gh pr create`,
   and on each scheduled check, the worker runs `gh pr view --json number,url,headRefName`,
   which returns the open PR whose head is the branch.
4. **Posting.** The worker renders the comment for every recorded session on that repository
   and branch, and creates it, or edits it with `gh api` (PATCH). Your comment is the one
   carrying the `<!-- sessionstat -->` marker *and* written by your `gh` user, so each
   contributor to a PR has a comment of their own. If nothing has changed, nothing is written.
5. **After the session ends.** You usually open the PR after the agent has finished, so the
   last hook has nothing to post to. `SessionEnd` queues checks at **+5 minutes, +30 minutes and
   +2 hours** in `~/.sessionstat/pr-checks/`, and starts a detached poller (one at a time, by a
   lock file) that sleeps until each check and posts if a PR has appeared. After the last check
   it gives up. Every hook run, in any repository, also starts a poller for checks that are
   overdue, so a poller killed by a reboot or a closed laptop is caught up the next time you use
   Claude Code. There is no launchd or cron job to install.
6. **Any time:** `sessionstat post` posts for the current branch now; `sessionstat show` prints
   the comment without posting.

At the start of a session in a GitHub repository, Claude Code shows a notice: *sessionstat:
stats for this session will be added to PR #12 for feature/x*, or the reason it will not be
(`gh auth login`). The PR lookup behind it has a 1.5 second timeout, after which a generic line
is shown. In a git repository with no GitHub remote it says so instead: *sessionstat: stats for
this session won't be posted until this repository has a GitHub remote* (or, for a remote
elsewhere, *…this repository's remote is not on GitHub*). `sessionstat config notice off` hides
it.

### The data block

Every comment ends with a hidden block holding the raw numbers:

```
<!-- sessionstat:data {"v":1,"branch":"feature/x","sessions":[...],"totals":{...}} -->
```

It is the PR's persisted state. Before updating your comment, sessionstat reads its block back
and merges in your local sessions by session id: local wins for sessions you have, and sessions
only in the block (from another machine, or after `~/.sessionstat` was wiped) are kept. The
comment is rendered from the merged set, so it never loses a session. `sessionstat show --all`
merges every contributor's block on the PR. Any `--` in the JSON is written as `--`, so the
block cannot close its own HTML comment.

Sessions are split into **build** (started before the PR existed) and **follow-up** (started
after it was opened: responding to review). The default template shows them as two tables.

## Project board

The comment is for reading; a [GitHub Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects)
board is for reporting. Optionally, sessionstat puts each PR on a board for the repository and
keeps number fields on it up to date, so GitHub's own table views (group by, sum) and Insights
charts show agent effort across PRs and over time. No server is involved.

When you run `sessionstat setup` in a terminal, it offers to set one up: create a board called
`sessionstat: owner/repo` (owned by the repository's owner and linked to the repository, so it
shows on its Projects tab), or paste the URL of an existing project. Add one later with
`sessionstat board setup`, or without questions:

```sh
sessionstat setup --project-board create
sessionstat setup --project-board https://github.com/orgs/acme/projects/7
sessionstat board setup create
sessionstat board status        # the project, each field, last sync, token scope
sessionstat board resync --pr 12   # rewrite a PR's fields from its comments (merged PRs too)
```

The token needs the `project` scope: `gh auth refresh -s project`. Setup checks for it.

After each comment is posted, the PR is added to the board and these fields are written. The
values are totals over **every** sessionstat comment on the PR (every contributor's data block),
recomputed each time and never incremented, so whoever posts last writes the complete total and
the board can always be rebuilt from the comments:

| Field | Type | |
|---|---|---|
| `Agent sessions`, `Agent turns`, `Agent tool calls` | Number | |
| `Agent active minutes` | Number | Sum of session durations |
| `Agent tokens (M)` | Number | Input + output + cache, in millions |
| `Agent cost (USD)` | Number | Actual spend; empty for subscription-only PRs |
| `Agent API value (USD)` | Number | The same tokens at API list price |
| `Agent errors` | Number | Tool errors + interruptions |
| `Agent model` | Single select | The model with the most session time; new models become new options |
| `Agent last session` | Date | |
| `Agent build sessions`, `Agent follow-up sessions` | Number | Before / after the PR was opened |
| `Agent follow-up minutes`, `Agent follow-up cost (USD)` | Number | Effort spent responding to review |

Fields are created if missing and matched by name; a field of yours with the same name and a
different type is left alone. Only changed values are written, in one request. A board that
cannot be written is logged (`sessionstat logs --errors`) and never stops the comment.

The setting lives under `boards` in `~/.sessionstat/config.json`, keyed by `owner/repo`, or,
to share it with the team, in `<repo>/.claude/sessionstat.json` (`sessionstat board setup
--repo`), which wins:

```json
{ "board": { "owner": "acme", "number": 7, "prefix": "Agent ", "fields": ["sessions", "minutes", "cost"] } }
```

`prefix` (default `Agent `) and `fields` (keys from `sessionstat board status`; all by default)
are optional.

## Commands

| Command | |
|---|---|
| `sessionstat setup [path] [--global \| --team] [--project-board <url\|create>] [--no-project-board] [--share-board] [--template <repo\|home\|none>]` | Install hooks (this repository, for the team with `--team`, or everywhere with `--global`) and the skill; check everything; offer a project board and a template to customise |
| `sessionstat board setup [url\|create] [--repo]` | Create or pick the repository's project board and add its fields |
| `sessionstat board status` | The board, its fields, last sync and token scope |
| `sessionstat board resync [--pr <number>]` | Rewrite a PR's board fields from its comments |
| `sessionstat uninstall [path] [--global \| --team]` | Remove your hooks from this repository, its team hooks, or the global ones |
| `sessionstat status` | Which scopes cover this repository, gh login, template in effect, sessions, queued checks, last error |
| `sessionstat show [--all] [--transcript <file...>] [--no-pr]` | Print the comment without posting |
| `sessionstat post [--force]` | Post or update the comment now |
| `sessionstat template init [--repo] [--force]` | Write the default template out to edit |
| `sessionstat template vars [--all] [--transcript <file...>] [--no-pr]` | Print the template's data as JSON |
| `sessionstat enable` / `disable [--global]` | Turn it on or off for this repository, or everywhere it is installed (a switch, not an install) |
| `sessionstat config [notice on\|off]` | Show settings, or toggle the start-of-session notice |
| `sessionstat logs [-n <lines>] [--errors]` | The end of `~/.sessionstat/sessionstat.log` |
| `sessionstat hook` | Internal: what the hooks run |

## The template

The comment is rendered from a [Mustache](https://mustache.github.io/mustache.5.html) template.
Mustache has no logic, so a template cannot throw at runtime; to hide a section, delete its
`{{#…}}…{{/…}}` block. The first of these that exists wins:

1. `<repo>/.claude/sessionstat.md`: per repository; commit it to share it with your team
   (the older `<repo>/.sessionstat.md` is still read)
2. `~/.sessionstat/template.md`: your own default
3. the template built into sessionstat (`src/template/default.md`)

`sessionstat template init` (or `--repo`) writes the default out to edit, `sessionstat template
vars` prints exactly what the template receives for the current branch, and `sessionstat show`
renders with whichever template wins. The `<!-- sessionstat -->` marker and the data block are
always added by sessionstat, so an edited template can never break updating the comment. A
template that fails to parse is logged, and the default is used instead.

### Variables

Numbers arrive formatted as strings (`"1h 12m"`, `"$3.41"`, `"1.2M"`), so templates never do
maths.

| Variable | |
|---|---|
| `pr.number`, `pr.url`, `pr.branch`, `repo`, `branch`, `generatedAt` | Where and when |
| `multipleSessions`, `singleSession`, `hasCost`, `hasValue`, `hasPlan`, `hasTests`, `testsFailing`, `hasErrors`, `hasBuild`, `hasFollowUp`, `bothPhases` | Flags for optional sections |
| `phaseSummary`, `groups[]{label,sessions[]}` | `2 build, 1 follow-up`; the sessions grouped under `Build` and `Follow-up` |
| `timeline` | The axis of the session bars: `from`, `to` (`Oct 14 09:00`, UTC), `minutesPerChar`, `hasBreaks`, `breakHours` |
| `totals` | `sessionCount`, `sessionNoun`, `duration`, `turns`, `toolCalls`, `filesEdited`, `commits`, `tokens.{input,output,cacheRead,cacheWrite,total}`, `cost`, `billed`, `costPartial`, `value`, `valuePartial`, `hasCost`, `hasValue`, `errors`, `interruptions`, `compactions`, `testRuns.{passed,failed}`, `successRate` |
| `buildTotals`, `followUpTotals` | The same, for each half |
| `sessions[]`, `buildSessions[]`, `followUpSessions[]` | `id`, `shortId`, `author`, `model`, `modelName` (`Opus 5.5`), `startedAt`, `started` (`Oct 14 09:00`), `duration`, `timeline` (the session's bar, for inside backticks in a table cell), `phase`, `phaseLabel`, `openedBeforePr`, `turns`, `toolCalls`, `tools[]{name,count}`, `filesEdited`, `commits[]{sha,short}`, `commitCount`, `tokens`, `billing`, `cost`, `billed`, `value`, `errors`, `interruptions`, `compactions`, `testRuns`, `successRate`, `processQuality`, `iterations` |

What the numbers mean: **prompts** are messages you typed (sub-agent prompts excluded); **tool
errors** are tool calls whose result came back as an error; **interruptions** are presses of
Esc; **compactions** are context compactions, manual or automatic; **tests** are Bash commands
that run a test suite (`pnpm test`, `vitest`, `pytest`, `go test`, …), passed if they exited
zero. Tool success, process
quality and iterations are computed exactly as [GuideMode](https://guidemode.dev) computes them.

There are two dollar figures, and they are never added together:

- **API value** is what the session's tokens cost at Anthropic's published API rates. It is
  Claude Code's own figure once it has written its end-of-session `cost-state` record, and until
  then is priced per request from a rate table vendored into sessionstat (`pnpm update-prices`
  refreshes it from [litellm](https://github.com/BerriAI/litellm)). A model with no published
  rate shows `–`, never a guess.
- **Billed** is what was actually paid. When the session ran on a Claude subscription (Pro, Max,
  Team…) nobody is invoiced per token, so it shows `plan` (`cost` says `subscription`); when it was billed per token
  (an API key, `ANTHROPIC_AUTH_TOKEN`, Bedrock, Vertex or Foundry) it equals the API value. The
  billing mode is detected by the hook on the machine that ran the session, from its environment
  and the logged-in account in `~/.claude.json`, and stored with the session.

## Configuration

`~/.sessionstat/config.json`:

| Key | Default | |
|---|---|---|
| `notice` | `true` | Show the start-of-session notice |
| `enabled` | `true` | `false` turns sessionstat off everywhere it is installed |
| `disabledRepos` | `[]` | Repository roots where it is off |
| `projectInstalls` | `[]` | Repositories with a project-scope install (kept by setup) |
| `boards` | `{}` | Project boards by `owner/repo`, unless the repository shares one in `.claude/sessionstat.json` |

## Troubleshooting

No comment on your PR?

- `sessionstat status`: installed for this repository (or globally)? `gh` logged in? repository disabled? sessions recorded on
  this branch? checks queued? last error?
- `gh auth status`: sessionstat comments as this user.
- `sessionstat logs --errors`: what the background workers did.
- `sessionstat show`: if this has no sessions, none was recorded on this branch. Sessions are
  recorded only inside a git repository, on a branch, with a GitHub remote for posting.
- `sessionstat post`: post now.

The PR must be open, and its head must be the branch the session worked on.

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm build && pnpm test
node dist/cli.js show --no-pr --transcript tests/fixtures/claude-code-synthetic.jsonl
```

The transcript parser and metric processors in `src/metrics/` are copied from GuideMode's
`session-processing` package and kept in step with it; `tests/metrics.test.ts` checks that
they produce the same numbers GuideMode does for the same fixtures.

## License

MIT

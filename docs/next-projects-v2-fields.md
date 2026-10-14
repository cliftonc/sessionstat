# Next step: mirror PR session stats into GitHub Projects v2 fields

## Why
The PR comment is for people to read, but you can't report on it. If each PR is an item in a
Projects v2 board with number fields, GitHub's own table views (group by, sum) and Insights
charts give the user reporting across PRs and over time, with no server. We'll also embed
hidden JSON in the comment (`<!-- sessionstat:data {...} -->`). That stays the source of
truth; the project fields are an opt-in mirror.

## User experience
```
sessionstat setup --project-board https://github.com/orgs/acme/projects/7
sessionstat setup --project-board create --owner acme   # create "Agent sessions" with the fields
sessionstat board status                                # project, fields, last sync, scope check
```
- **Where the setting lives:** it's stored in `config.json`, globally or per repo (a
  `.sessionstat.json` next to `.sessionstat.md` for a project install).
- **Scope check:** setup checks that the token has the `project` scope. If not, it prints
  `gh auth refresh -s project` and marks that check ✗.
- **Skill:** the sessionstat skill gets a section on this.

## Fields (created if missing, matched by name; never rename the user's own fields)
| Field | Type | Value |
|---|---|---|
| Agent sessions | Number | count of sessions on the PR |
| Agent active minutes | Number | sum of active duration |
| Agent turns | Number | user turns |
| Agent tool calls | Number | |
| Agent tokens (M) | Number | input + output + cache, millions |
| Agent cost (USD) | Number | estimated |
| Agent errors | Number | tool errors + interruptions |
| Agent model | Single select | main model; options added when new ones appear |
| Agent last session | Date | |
| Agent build sessions / Agent follow-up sessions | Number | split by `openedBeforePr` |
| Agent follow-up minutes / Agent follow-up cost (USD) | Number | review-response effort |

All names get a configurable prefix (`Agent `), so they don't collide with existing fields.
The field list is driven by the same `CommentView` the template uses, so there's one source.

## Flow (it runs straight after a successful comment post, in the same detached worker)
1. **Resolve the project and its fields:** `projectV2(number)` under `organization` or `user`,
   then `fields { ... on ProjectV2Field / ProjectV2SingleSelectField }`. Cache their ids in
   `~/.sessionstat/board-cache.json`, and refresh the cache when a mutation fails because an
   id is unknown.
2. **Make sure the PR is an item:** `addProjectV2ItemById(projectId, contentId: pr.node_id)`.
   It's idempotent and returns the existing item. Get `pr.node_id` from
   `gh pr view --json id`.
3. **Write the fields:** `updateProjectV2ItemFieldValue` once per changed field, skipping any
   whose value hasn't changed (diff against the last write, stored in scratch). Writing a
   number replaces the old value, so totals are always recomputed across the PR's sessions
   and never incremented.
4. **On failure:** log it and carry on. A board failure must never stop the comment from
   being posted.

## State lives in the hidden data block
The `<!-- sessionstat:data {...} -->` block in each person's comment is the persisted state
for the PR, built in v1:
- **When updating its own comment,** the CLI merges in its local sessions by `sessionId` and
  keeps any sessions the block already had (from another machine, or from before the scratch
  was wiped).
- **`readPrState(pr)`** takes the union of every author's block. The board writes from that
  union, so the board itself holds no state; it can be rebuilt from the comments at any time
  (`sessionstat board resync`).

## Decisions (Clifton, 2026-10-14)
- **Every PR with sessions goes on the board.** `addProjectV2ItemById` runs on every post, so
  there's no `addToProject` setting.
- **One board per repo.** The board is called `sessionstat: <owner>/<repo>`. It's owned by the
  repo owner (org or user) and linked to the repo with `linkProjectV2ToRepository`, so it shows
  up on the repo's Projects tab. `setup --project-board create` makes it for the current repo.
  The board id is cached for each repo in `board-cache.json`, keyed by `owner/repo`.
- **Cost is included** by default. `fields:` in the config can still leave fields out.
- **Sessions are combined**, across people and over the life of the PR:
  - *Across people:* each person's CLI keeps writing its own comment, because you can't edit
    someone else's. Before writing the board, the poster reads **every** comment on the PR
    that carries a `sessionstat:data` block, whoever wrote it, takes the union of their
    sessions by `sessionId`, and writes those totals. Whoever posts last writes the complete
    total, and a stale writer can only ever be outdone by the next post.
  - *Across commits and time:* a session belongs to every branch it was on (`branches[]`), so
    the first build session, later fix-up sessions and a review-response session after
    comments all add to the same PR, whenever they happen.
  - *Session kind:* each session records whether the PR already existed when it started
    (`openedBeforePr` true or false). This lets the comment and the board split the work into
    **build** (before the PR) and **follow-up** (after the PR is open: review responses,
    fixes). Fields: `Agent build sessions`, `Agent follow-up sessions`, and follow-up
    minutes and cost.
  - *Commits:* at each Stop, the session records any new HEAD SHAs on the branch, so the
    comment can say which commits a session produced. That lets a review-response session be
    tied to the commits it pushed.

## Limits to keep in mind
- Projects have a cap on the number of fields; we use about 9.
- There's a GraphQL rate limit of 5,000 points an hour per user, and our writes are
  per-field, so diff before writing.
- The token needs the `project` scope, a classic token or `gh` login; fine-grained tokens
  need Projects permission on the org.
- Insights charts can sum number fields, but charts can't sum Date or Single-select fields.

## Tests
- A fake GraphQL runner: field creation when fields are missing, using the id cache, retrying
  after a stale id, skipping unchanged writes, adding an item idempotently.
- A missing `project` scope → a setup ✗ with the fix printed, while posting the comment still
  works.
- End to end against a throwaway user-owned project.

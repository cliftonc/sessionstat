{{! sessionstat default template. Copy it with `sessionstat template init` and edit freely. }}
{{! Each section below is one #name ... /name block: delete a block to hide that section. }}
{{! `sessionstat template vars` prints every field you can use. }}
{{! The marker and the hidden data block are added for you; you do not need them here. }}
{{! ---- Summary ---- }}
### 🤖 Claude Code session stats

{{#totals}}
**{{sessionCount}} {{sessionNoun}}** · {{duration}} · {{turns}} prompts · {{toolCalls}} tool calls · {{filesEdited}} files edited{{#cost}} · {{cost}}{{/cost}}
{{/totals}}

{{! ---- Sessions, split into build (before the PR) and follow-up (after it opened). ---- }}
{{! Folded into a details element when there is more than one session. }}
{{#multipleSessions}}
<details>
<summary>Sessions</summary>

{{/multipleSessions}}
{{#hasBuild}}
{{#hasFollowUp}}
**Build** — before the PR was opened

{{/hasFollowUp}}
| Session | Author | Model | Started | Duration | Prompts | Tool calls | Files | Commits | Cost |
|---|---|---|---|---|---|---|---|---|---|
{{#buildSessions}}
| `{{shortId}}` | {{author}} | {{model}} | {{startedAt}} | {{duration}} | {{turns}} | {{toolCalls}} | {{filesEdited}} | {{commitCount}} | {{cost}} |
{{/buildSessions}}

{{/hasBuild}}
{{#hasFollowUp}}
**Follow-up** — after the PR was opened ({{followUpTotals.sessionCount}} {{followUpTotals.sessionNoun}}, {{followUpTotals.duration}})

| Session | Author | Model | Started | Duration | Prompts | Tool calls | Files | Commits | Cost |
|---|---|---|---|---|---|---|---|---|---|
{{#followUpSessions}}
| `{{shortId}}` | {{author}} | {{model}} | {{startedAt}} | {{duration}} | {{turns}} | {{toolCalls}} | {{filesEdited}} | {{commitCount}} | {{cost}} |
{{/followUpSessions}}

{{/hasFollowUp}}
{{#multipleSessions}}
</details>
{{/multipleSessions}}

{{! ---- Tokens & cost ---- }}
{{#totals}}
**Tokens:** {{tokens.input}} in · {{tokens.output}} out · {{tokens.cacheRead}} cache read · {{tokens.cacheWrite}} cache write{{#hasCost}} · **Cost:** {{cost}}{{#costPartial}} (some sessions not yet priced){{/costPartial}}{{/hasCost}}
{{/totals}}

{{! ---- Quality ---- }}
{{#totals}}
**Quality:** {{successRate}} tool success · tool errors: {{errors}} · interruptions: {{interruptions}} · compactions: {{compactions}}{{#hasTests}} · tests: {{testRuns.passed}} passed, {{testRuns.failed}} failed{{/hasTests}}
{{/totals}}

<sub>Posted by [sessionstat](https://www.npmjs.com/package/sessionstat) · updated {{generatedAt}}</sub>

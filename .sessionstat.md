{{! sessionstat default template. Copy it with `sessionstat template init` and edit freely. }}
{{! Each section below is one #name ... /name block: delete a block to hide that section. }}
{{! `sessionstat template vars` prints every field you can use. }}
{{! The marker and the hidden data block are added for you; you do not need them here. }}
{{! Cost is what was actually billed ("subscription" when a Claude plan covered it); API value }}
{{! is what the same tokens cost at published API rates. They are never added together. }}
{{! ---- Summary ---- }}
### 🤖 Claude Code session stats

{{#totals}}
**{{sessionCount}} {{sessionNoun}}** · {{duration}} · {{turns}} prompts · {{toolCalls}} tool calls · {{filesEdited}} files edited{{#hasCost}} · **Cost:** {{cost}}{{#costPartial}} (some sessions unknown){{/costPartial}}{{/hasCost}}{{#hasValue}} · **API value:** {{value}}{{#valuePartial}} (some sessions unpriced){{/valuePartial}}{{/hasValue}}
{{/totals}}

{{! ---- Sessions, split into build (before the PR) and follow-up (after it opened). ---- }}
{{! Three narrow tables per group: who and when, the work and its cost, tokens. }}
{{! Folded into a details element when there is more than one session. }}
{{#multipleSessions}}
<details>
<summary>Sessions</summary>

{{/multipleSessions}}
{{#hasBuild}}
{{#hasFollowUp}}
**Build** — before the PR was opened

{{/hasFollowUp}}
| Session | Author | Model | Started | Duration |
|---|---|---|---|---|
{{#buildSessions}}
| `{{shortId}}` | {{author}} | {{model}} | {{startedAt}} | {{duration}} |
{{/buildSessions}}

| Session | Prompts | Tool calls | Files | Commits | Cost | API value |
|---|--:|--:|--:|--:|--:|--:|
{{#buildSessions}}
| `{{shortId}}` | {{turns}} | {{toolCalls}} | {{filesEdited}} | {{commitCount}} | {{cost}} | {{value}} |
{{/buildSessions}}
{{#buildTotals}}
| **Total** | **{{turns}}** | **{{toolCalls}}** | **{{filesEdited}}** | **{{commits}}** | **{{cost}}** | **{{value}}** |
{{/buildTotals}}

| Session | Input | Output | Cache read | Cache write |
|---|--:|--:|--:|--:|
{{#buildSessions}}
| `{{shortId}}` | {{tokens.input}} | {{tokens.output}} | {{tokens.cacheRead}} | {{tokens.cacheWrite}} |
{{/buildSessions}}
{{#buildTotals}}
| **Total** | **{{tokens.input}}** | **{{tokens.output}}** | **{{tokens.cacheRead}}** | **{{tokens.cacheWrite}}** |
{{/buildTotals}}

{{/hasBuild}}
{{#hasFollowUp}}
**Follow-up** — after the PR was opened ({{followUpTotals.sessionCount}} {{followUpTotals.sessionNoun}}, {{followUpTotals.duration}})

| Session | Author | Model | Started | Duration |
|---|---|---|---|---|
{{#followUpSessions}}
| `{{shortId}}` | {{author}} | {{model}} | {{startedAt}} | {{duration}} |
{{/followUpSessions}}

| Session | Prompts | Tool calls | Files | Commits | Cost | API value |
|---|--:|--:|--:|--:|--:|--:|
{{#followUpSessions}}
| `{{shortId}}` | {{turns}} | {{toolCalls}} | {{filesEdited}} | {{commitCount}} | {{cost}} | {{value}} |
{{/followUpSessions}}
{{#followUpTotals}}
| **Total** | **{{turns}}** | **{{toolCalls}}** | **{{filesEdited}}** | **{{commits}}** | **{{cost}}** | **{{value}}** |
{{/followUpTotals}}

| Session | Input | Output | Cache read | Cache write |
|---|--:|--:|--:|--:|
{{#followUpSessions}}
| `{{shortId}}` | {{tokens.input}} | {{tokens.output}} | {{tokens.cacheRead}} | {{tokens.cacheWrite}} |
{{/followUpSessions}}
{{#followUpTotals}}
| **Total** | **{{tokens.input}}** | **{{tokens.output}}** | **{{tokens.cacheRead}}** | **{{tokens.cacheWrite}}** |
{{/followUpTotals}}

{{/hasFollowUp}}
{{#multipleSessions}}
</details>
{{/multipleSessions}}

{{! ---- Quality ---- }}
{{#totals}}
**Quality:** {{successRate}} tool success · tool errors: {{errors}} · interruptions: {{interruptions}} · compactions: {{compactions}}{{#hasTests}} · tests: {{testRuns.passed}} passed, {{testRuns.failed}} failed{{/hasTests}}
{{/totals}}

<sub>Posted by [sessionstat](https://www.npmjs.com/package/sessionstat) · updated {{generatedAt}}</sub>

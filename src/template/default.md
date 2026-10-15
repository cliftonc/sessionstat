{{! sessionstat default template. Copy it with `sessionstat template init` and edit freely. }}
{{! Each section below is one #name ... /name block: delete a block to hide that section. }}
{{! `sessionstat template vars` prints every field you can use. }}
{{! The marker and the hidden data block are added for you; you do not need them here. }}
{{! Billed is what was actually paid ("plan" when a Claude subscription covered it); API value }}
{{! is what the same tokens cost at published API rates. They are never added together. }}
{{! ---- Headline: the totals for the PR ---- }}
{{#totals}}
### Claude Code · {{sessionCount}} {{sessionNoun}} · {{duration}}

| Time | Prompts | Tool calls | Files | Commits | Tokens | Billed | API value |
|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **{{duration}}** | **{{turns}}** | **{{toolCalls}}** | **{{filesEdited}}** | **{{commits}}** | **{{tokens.total}}** | **{{billed}}** | **{{value}}** |
{{/totals}}

{{! ---- One session: a single row with what the headline cannot show ---- }}
{{#singleSession}}
| Session | Model | Started | Input | Output | Cache read | Cache write |
|---|---|---|--:|--:|--:|--:|
{{#sessions}}
| `{{shortId}}` {{author}} | {{modelName}} | {{started}} | {{tokens.input}} | {{tokens.output}} | {{tokens.cacheRead}} | {{tokens.cacheWrite}} |
{{/sessions}}

<sub>{{#hasBuild}}Before the PR was opened.{{/hasBuild}}{{#hasFollowUp}}After the PR was opened.{{/hasFollowUp}}{{#hasPlan}} Billed "plan": covered by a Claude subscription.{{/hasPlan}}</sub>
{{/singleSession}}

{{! ---- Several sessions: a timeline of the work, then tokens and cost, folded ---- }}
{{#multipleSessions}}
<details>
<summary><b>Sessions</b> · {{phaseSummary}} · {{timeline.from}} to {{timeline.to}} UTC</summary>

#### Activity

| Session | Time | {{timeline.from}} → {{timeline.to}} | Prompts | Tools | Files | Commits |
|---|--:|---|--:|--:|--:|--:|
{{#groups}}
{{#bothPhases}}
| **{{label}}** | | | | | | |
{{/bothPhases}}
{{#sessions}}
| `{{shortId}}` {{author}} | {{duration}} | `{{timeline}}` | {{turns}} | {{toolCalls}} | {{filesEdited}} | {{commitCount}} |
{{/sessions}}
{{/groups}}

#### Tokens and cost

| Session | Model | Input | Output | Cache read | Cache write | Tokens | Billed | API value |
|---|---|--:|--:|--:|--:|--:|--:|--:|
{{#groups}}
{{#bothPhases}}
| **{{label}}** | | | | | | | | |
{{/bothPhases}}
{{#sessions}}
| `{{shortId}}` {{author}} | {{modelName}} | {{tokens.input}} | {{tokens.output}} | {{tokens.cacheRead}} | {{tokens.cacheWrite}} | {{tokens.total}} | {{billed}} | {{value}} |
{{/sessions}}
{{/groups}}
{{#totals}}
| **Total** | | **{{tokens.input}}** | **{{tokens.output}}** | **{{tokens.cacheRead}}** | **{{tokens.cacheWrite}}** | **{{tokens.total}}** | **{{billed}}** | **{{value}}** |
{{/totals}}

<sub>{{#bothPhases}}Build: before the PR was opened; follow-up: after. {{/bothPhases}}Timeline: real time, each character ≈ {{timeline.minutesPerChar}} min{{#timeline.hasBreaks}}; <code>\|\|</code> is a break of more than {{timeline.breakHours}}h left out{{/timeline.hasBreaks}}.{{#hasPlan}} Billed "plan": covered by a Claude subscription.{{/hasPlan}}{{#totals.costPartial}} Some sessions' spend is unknown.{{/totals.costPartial}}{{#totals.valuePartial}} Some sessions are unpriced.{{/totals.valuePartial}}</sub>

</details>
{{/multipleSessions}}

{{! ---- Quality ---- }}
{{#totals}}
**Quality** · {{successRate}} tool success{{#hasTests}} · tests: {{testRuns.passed}} passed, {{#testsFailing}}**{{testRuns.failed}} failed**{{/testsFailing}}{{^testsFailing}}0 failed{{/testsFailing}}{{/hasTests}} · tool errors: {{errors}} · interruptions: {{interruptions}} · compactions: {{compactions}}
{{/totals}}

<sub>Posted by [sessionstat](https://www.npmjs.com/package/sessionstat) · updated {{generatedAt}}</sub>

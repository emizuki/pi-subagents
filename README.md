# pi-subagents

Delegate tasks to subagents that run in their own `pi` process, with an isolated context
window — and pick the model and thinking level **per call**, not just per agent file.

Derived from the `subagent/` example in the [pi repository](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent).

## Why

The upstream example pins a model in each agent's frontmatter. That breaks when you switch
providers often: `model: claude-haiku-4-5` is meaningless once the session is on an OpenAI
provider, and an agent that pins a model silently loses the session's thinking level.

This fork moves both choices to the call site. The model enum is generated from the live
catalogue, so it always reflects whichever provider the session is on.

## Install

```bash
pi install git:github.com/emizuki/pi-subagents
```

Agent definitions are not a pi resource type, so copy the samples yourself:

```bash
mkdir -p ~/.pi/agent/agents
for f in agents/*.md; do ln -sf "$PWD/$f" ~/.pi/agent/agents/; done
```

Symlink rather than copy: `pi install` references a local package in place, so the extension
tracks the repo, and linking the agents keeps them in step too. Copies go stale the first time
you edit an agent here and forget that the installed one is a different file.

The samples ship without a `model:` pin, so they inherit whatever the session is on. Add a pin
only when a specific agent should deviate.

## Usage

```
Use scout to find all authentication code
Run 2 scouts in parallel: one for models, one for providers
Use a chain: scout finds the auth code, then general-purpose adds a test for it
```

## Tool modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Concurrent (max 8 tasks, 4 at a time) |
| Chain | `{ chain: [...] }` | Sequential, with a `{previous}` placeholder |

Every mode accepts `model` and `thinking`, per task in parallel and chain mode.

## Choosing a model

Precedence, highest first:

1. the call's `model`
2. the agent's frontmatter `model:`
3. the dispatching session's model

The same order applies to `thinking`. An agent that pins a model does **not** inherit the
session's thinking level — but a per-call `thinking` still overrides everything.

`--model` accepts an optional `:<level>` suffix, so frontmatter can pin both at once:

```markdown
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
model: gpt-5.6-luna:low
---
```

The suffix is only split off when the tail is a real thinking level, so model ids that
contain a colon (`llama3:8b`) are left alone.

### Which models are offered

The `model` enum is built at registration time from `ctx.scopedModels` when session scoping
is configured (`--models`, or `enabledModels` in settings), and otherwise from the current
provider's catalogue. Scoping is the intended way to keep expensive models out of reach:

```bash
pi --models "gpt-5.6-*"
```

The enum is rebuilt on `session_start` (which also covers `/new`, `/resume` and `/fork`) and
on `model_select`, so switching providers mid-session keeps the list accurate.

### Which thinking levels are offered

Thinking support is per model. pi describes it with `thinkingLevelMap`, where a `null` marks
a level unsupported and a missing key means the level works up to `high` but leaves `xhigh`
and `max` unsupported. A model with `reasoning: false` supports only `off`.

Because the model is chosen in the same call, the schema can only offer the union of levels
across the offered models. The real check happens before the subprocess is spawned: an
unsupported pair fails with the list of levels that model does accept, rather than being
clamped silently by pi.

The map differs per provider for the same model id, so validation is keyed on `provider/id`.

### What the enum cannot know

The catalogue lists what a provider publishes, not what your account is entitled to use. A
model can be offered and still be rejected at run time, for example:

```
Error: Codex error: The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.
```

Nothing local can predict that, so the provider's error is surfaced as-is. Narrow the enum
with `--models` or `enabledModels` once you know which models your account actually accepts.

## Sample agents

| Agent | For | Tools |
|-------|-----|-------|
| `general-purpose` | Anything open-ended: investigate, then act | full |
| `scout` | Fast recon, returns compressed findings | read, grep, find, ls, bash |

Neither pins a model, so both follow the session.

Two agents, not five. A subagent earns its place when the task is self-contained given a
description — gathering facts, or doing a delimited job. Planning is not: it wants the whole
conversation, which is exactly what an isolated context does not have, so the dispatching
agent should plan for itself. `scout` is kept because being restricted and cheap is the point
of it, and it pairs with the guideline below.

`scout` has `bash`, so it can reach any search tool on the box. pi's built-in `grep` is
ripgrep already, so plain text search needs no shell at all; `ast-grep` is worth shelling out
for when the query is structural. Note that `sg` is not an alias for it on Linux — that name
belongs to util-linux — so the agent prompt names `ast-grep` explicitly.

## Nudging the caller

Omitting `model` is the documented default, and a full-tool agent is the obvious thing to
reach for, so left alone the caller will use the expensive agent on the expensive model even
for a read-only look around. The extension emits `promptGuidelines` covering both choices:

```
Call the subagent tool with agent: "scout" whenever the task is read-only investigation —
searching, listing, reading or summarising. Reserve the full-tool agents for work that must
actually change something.

For that read-only work, also pass a cheaper model to the subagent tool: its model parameter
lists models cheapest first. The cheapest on offer costs about 25x less per input token than
the session's model.
```

No model is named on purpose. A name becomes the only model the caller ever reaches for, and
a catalogue entry is not proof the account may use it. Instead the `model` enum is ordered
cheapest first and the guideline says so, which leaves the caller free to fall back when one
model is refused. The ratio, the ordering and the agent names are all computed at registration
time, so they follow the active provider and the agents actually on disk. Nothing is emitted
when the session is already on the cheapest model, or when no model carries a price.

## Depth limit

A subagent inherits this process's environment, so it loads the same packages and would
otherwise be offered the tool again — subagents spawning subagents, multiplying cost with
nothing in the transcript to explain it. Each spawn sets `PI_SUBAGENT_DEPTH`, and the tool
is not registered at all once that reaches `MAX_SUBAGENT_DEPTH` (1). One level of delegation
is useful; a tree of it is a bill.

## Agent definitions

Markdown with YAML frontmatter, in `~/.pi/agent/agents/*.md` (user level, always loaded) or
`.pi/agents/*.md` (project level, only with `agentScope: "project"` or `"both"`).

```markdown
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
model: gpt-5.6-sol
---

System prompt for the agent goes here.
```

Omit `model` to inherit the dispatching session's model and thinking level.

## Security

Each call runs a separate `pi` subprocess with a delegated system prompt and tool
configuration. Project-local agents are repo-controlled prompts that can instruct the model
to read files and run commands, so only user-level agents load by default. Pass
`agentScope: "both"` for repositories you trust; untrusted projects additionally prompt for
confirmation unless `confirmProjectAgents: false` is set.

## Limitations

- Collapsed view shows the last 10 items; Ctrl+O expands.
- Parallel model-visible output is capped at 50 KB per task.
- Agents are rediscovered on each invocation, so they can be edited mid-session.
- Parallel mode is limited to 8 tasks, 4 concurrent.

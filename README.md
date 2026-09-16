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
pi install git:github.com/<you>/pi-subagents
```

Agent definitions are not a pi resource type, so copy the samples yourself:

```bash
mkdir -p ~/.pi/agent/agents
cp agents/*.md ~/.pi/agent/agents/
```

## Usage

```
Use scout to find all authentication code
Run 2 scouts in parallel: one for models, one for providers
Use a chain: scout finds the read tool, then planner suggests improvements
```

Workflow prompts: `/implement`, `/scout-and-plan`, `/implement-and-review`.

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
name: planner
description: Creates implementation plans
tools: read, grep, find, ls
model: claude-sonnet-5:high
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

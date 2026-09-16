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
Use recon to find all authentication code
Run 2 recon agents in parallel: one for models, one for providers
Use a chain: recon finds the auth code, then general-purpose adds a test for it
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
name: recon
aliases: scout
description: Fast codebase recon
tools: read, grep, find, ls
thinking: low
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
| `recon` | Fast codebase recon, returns compressed findings | read, grep, find, ls |

Neither pins a model, so both follow the session.

Two agents, not five. A subagent earns its place when the task is self-contained given a
description — gathering facts, or doing a delimited job. Planning is not: it wants the whole
conversation, which is exactly what an isolated context does not have, so the dispatching
agent should plan for itself. `recon` is kept because being restricted and cheap is the point
of it, and it pairs with the guideline below.

`recon` deliberately has no shell. Its whole value is being cheap and unable to change
anything, and a `bash` in the list would make the restriction decorative — the guideline below
steers read-only work to it on exactly that promise. pi's built-in `grep` is ripgrep, so
ordinary search needs no shell anyway. Structural search with `ast-grep` does, which is one
more reason it belongs to `general-purpose`: a task that needs it is not a quick recon. That
prompt names `ast-grep` explicitly, because `sg` on Linux is util-linux's setgid utility and
calling it does something unrelated instead of failing.

## Nudging the caller

Omitting `model` is the documented default, and a full-tool agent is the obvious thing to
reach for, so left alone the caller will use the expensive agent on the expensive model even
for a read-only look around. The extension emits `promptGuidelines` covering both choices:

```
Call the subagent tool with agent: "recon" whenever the task is read-only investigation —
searching, listing, reading or summarising. Reserve the full-tool agents for work that must
actually change something.

For that read-only work, also pass a cheaper model to the subagent tool: its model parameter
lists models cheapest first.
```

No model is named, and no price ratio is quoted. Both pin the caller to one model, and a
catalogue entry is not proof the account may use it. Catalogue prices are list prices in any
case, which a subscription account may not be paying. Instead the `model` enum is ordered
cheapest first and the guideline says only that, which leaves the caller free to fall back when
one model is refused. The ordering and the agent names are computed at registration time, so
they follow the active provider and the agents actually on disk. Nothing is emitted when the
session is already on the cheapest model, or when no model carries a price.

## Context: fresh or fork

A child starts `fresh` by default — it gets the task text and nothing else. Passing
`context: "fork"` branches the dispatching session's transcript instead, so the child already
knows what the conversation has established.

Fork is expensive and the default is not an accident. A working session here measured 11.2 MB
of transcript; forking hands every child a copy of that to pay for on every turn. Reach for it
when the task is meaningless without the conversation, not to save yourself writing a task
description.

An explicit `context: "fork"` is a requirement: it fails when the parent session is ephemeral
or its file is gone. A fork coming from an agent's `defaultContext` or from
`subagents.defaultContext` is a preference, and runs fresh instead of failing.

The branch is taken from a sanitized copy. Reasoning blocks are stripped first, everywhere they
appear — a `thinkingSignature` names a reasoning item belonging to the response chain that
produced it (`rs_…` on OpenAI, a signed blob on Anthropic), and replayed from a branch it points
at something the new chain never emitted. They are not only on `message.content` either: this
tool stores each child transcript under `message.details`, so a session that has dispatched
subagents carries nested copies. On that 11.2 MB session the sweep removed 445 reasoning blocks
and left every `text` and `toolCall` block untouched.

Forked children write into a scratch session directory, so delegated runs never appear in the
operator's session list.

## Asking instead of guessing

A child that meets a real decision can ask, with `contact_supervisor`:

| `reason` | Behaviour |
|----------|-----------|
| `need_decision` | Blocks until the operator answers |
| `interview_request` | Blocks, for structured input |
| `progress_update` | Does not block; surfaces a notification |

The channel is a scratch directory created per dispatch and handed to the child through
`PI_SUBAGENT_IPC_DIR`: the child writes `<id>.req.json`, the parent answers with `<id>.res.json`,
both staged under a temporary name and renamed into place so neither side can read a half-written
file. The parent claims a request by renaming it before awaiting the answer, so a reply that sits
on a human for minutes is never handed out twice.

Files rather than a socket, which is also what `nicobailon/pi-subagents` settled on: a request has
to outlive the process that made it, and a socket dies with it. Requests are polled every 250 ms —
imperceptible next to a human deciding.

The tool is registered only inside a spawned child, and it is appended to that agent's `tools`
allowlist automatically, since an agent with an explicit list could otherwise never reach it.
Delegation stops at one level, but asking upward does not: the tool a child gets is the one
pointing back up, not the one pointing further down.

When the parent has no UI, the channel is not offered at all, rather than handing children a
question that could only time out. A request that goes unanswered for ten minutes returns an
instruction to proceed and state the assumption, which is also what an unreachable operator gets.

## Detached runs

`async: true` on a single dispatch starts the child and returns a run id straight away:

```
{ agent: "general-purpose", task: "...", async: true }
  -> Started 4f2a9c31 (general-purpose), detached.

{ action: "status" }                      // every run this session
{ action: "status", id: "4f2a9c31" }      // one run, with its output once finished
{ action: "stop",   id: "4f2a9c31" }
```

A detached run gets its own `AbortController` rather than the dispatching tool call's signal,
which fires the moment that call returns — for a detached run, immediately. `stop` aborts that
controller, and so does session shutdown: children are separate processes, and without that they
survive `/new`, `/resume`, `/fork` and exit, still spending tokens against a session nobody is
watching.

Parallel and chain stay synchronous, and passing `async` with either is rejected rather than
ignored. Both keep something detaching would cost: chain exists so that `{previous}` reaches the
next step inside one call, and parallel streams `2/3 done, 1 running` as the work lands, which a
detached run cannot do because the tool call is already over. To detach that work, start each
task as its own async single dispatch and collect them with `{ action: "status" }`.

What that costs is real: a slow fan-out blocks the turn, there is no per-run timeout inside one,
and a wedged child wedges the whole call until it is aborted.

## Resuming a child

A reviewer that finds a fault is only useful if the agent that wrote the code can be handed that
finding. Re-dispatching a fresh child from a task description loses everything it learned, so a
finished child can be revived instead:

```
{ agent: "general-purpose", task: "Implement the parser" }   -> run 4f2a9c31
{ agent: "recon", task: "Review what changed" }              -> finds a fault
{ resume: "4f2a9c31", task: "The review found X. Fix it." }
```

`async: true` works with `resume` as well, detaching the revived child. `model`, `thinking` and
`context` are rejected on a resume rather than ignored: a revived child keeps the contract it was
launched with, so silently dropping them would have been worse than refusing.

A run that is still in flight cannot be resumed — two children appending to one transcript
corrupts it — and a run whose session file has since disappeared reports `not resumable` rather
than launching against a path that is gone.

`resume` and `agent` are mutually exclusive. A revived child keeps its stored agent, model,
thinking level and tool allowlist rather than re-deriving them, and its system prompt is not
appended again — the session already carries it.

Every dispatch reports its run id — a single run appends `(run 4f2a9c31)`, parallel tags each
task heading, and a chain lists `step N: run …` at the end — because three parallel tasks running
the same agent are otherwise indistinguishable, and resuming the second of them is exactly the
case this exists for.

`{ action: "runs" }` lists retained runs and says `resumable` or `not resumable` for each, which
is worth checking before building a plan around reviving one. A run with no retained session file
reports `not resumable`; start a fresh agent of the same role and say that it is a fallback.

This is why children no longer run `--no-session`. Each run gets a session under a retention root
belonging to this process, never the operator's session directory, and the whole root is deleted
on session shutdown. Retention is per parent session and does not survive a restart.

## Depth limit

A subagent inherits this process's environment, so it loads the same packages and would
otherwise be offered the tool again — subagents spawning subagents, multiplying cost with
nothing in the transcript to explain it. Each spawn sets `PI_SUBAGENT_DEPTH`, and the tool
is not registered at all once that reaches `MAX_SUBAGENT_DEPTH` (1). One level of delegation
is useful; a tree of it is a bill.

## Frontmatter

| Field | Default | Effect |
|-------|---------|--------|
| `name` | — | Canonical name |
| `aliases` | none | Other names this agent answers to, matched case-insensitively |
| `description` | — | Shown to the dispatching model |
| `tools` | all | Tool allowlist |
| `model` | inherit | Model, optionally with a `:<level>` thinking suffix |
| `thinking` | inherit | Thinking level, independent of the model spec |
| `inheritSkills` | `false` | Whether the child rediscovers pi's skill catalogue |
| `inheritProjectContext` | `true` | Whether the child loads `AGENTS.md` / `CLAUDE.md` from its cwd |

`aliases` exists because callers reach for habitual names. Superpowers, for instance, hardcodes
`Subagent (general-purpose):` in its dispatch templates, and models improvise around it with
`general`, `explorer` or `Explore`. Answering to those costs one line of YAML; failing the
dispatch and retrying costs a turn.

`inheritSkills` defaults to off deliberately. A child that rediscovers the skill catalogue pays
for it on every single dispatch, and the task it was handed is narrower than the catalogue.
`inheritProjectContext` defaults to on for the opposite reason: a delegated edit should respect
the conventions of the repository it runs in.

Aliases also resolve in the project-agent confirmation path, so an alias cannot be used to run
a repo-controlled prompt without the prompt that a canonical name would have triggered.

## Settings

```json
{
  "subagents": {
    "defaultThinking": "low",
    "maxThinking": "high"
  }
}
```

`defaultThinking` applies to agents that specify no thinking level of their own, independent of
the parent session's level. `maxThinking` is a ceiling: a request above it is clamped, not
rejected, because the caller asked for work rather than for a particular amount of deliberation.
Both are read fresh on each dispatch, project settings overriding user settings.

## Agent definitions

Markdown with YAML frontmatter, in `~/.pi/agent/agents/*.md` (user level, always loaded) or
`.pi/agents/*.md` (project level, only with `agentScope: "project"` or `"both"`).

```markdown
---
name: recon
aliases: scout
description: Fast codebase recon
tools: read, grep, find, ls
thinking: low
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

## Checks

`./check.sh` type-checks for unresolved identifiers. It exists because `bun build` only
transpiles: it will happily emit a call to a function that does not exist, which is exactly how a
deleted helper reached main here. The peer dependencies are not installed, so module-resolution
errors are expected and ignored; only `TS2304`/`TS2551`/`TS2552` fail the run.

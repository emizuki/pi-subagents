# pi-subagents

Delegate tasks to subagents that run in their own `pi` process, with an isolated context
window — and pick the model and thinking level **per call**, not just per agent file.

Derived from the `subagent/` example in the [pi repository](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent).

## Why

The upstream example pins a model in each agent's frontmatter. That is inflexible when tasks
need different models, and an agent that pins a model silently loses the session's thinking level.

This fork moves both choices to the call site. The model enum follows Pi's current session scope,
or every model Pi considers available across all providers when the session is unscoped.

## Install

```bash
pi install npm:@emizuki/pi-subagents
```

That is the only required step. The extension loads its bundled agents directly from the installed
package; no copy or symlink into `~/.pi/agent/agents` is needed.

To track the development branch directly instead:

```bash
pi install git:github.com/emizuki/pi-subagents
```

Older releases asked users to create agent symlinks manually. Existing links remain compatible and
shadow the identical bundled definitions as user agents, but they can be removed once this version
is installed.

The bundled agents ship without a `model:` pin, so they inherit whatever the session is on. Add a
pin only when a specific agent should deviate.

## Usage

```
Use recon to find all authentication code
Use reviewer to review the current diff without changing files
Run 2 recon agents in parallel: one for models, one for providers
Use a chain: recon finds the auth code, then general-purpose adds a test for it
```

## Tool modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Concurrent (8 tasks, 4 at a time by default; see [Settings](#settings)) |
| Chain | `{ chain: [...] }` | Sequential, with a `{previous}` placeholder |

Every mode accepts `model`, `thinking` and `context`. In parallel and chain mode a per-item value
wins over the top-level one, which applies to every item that does not set its own.

## Choosing a model

Precedence, highest first:

1. the call's `model`
2. the agent's frontmatter `model:`
3. the dispatching session's model

Thinking precedence is: per-call `thinking`, a suffix on the per-call model, agent
`thinking:`, a suffix on the agent model, the selected scoped model's pinned thinking level,
`defaultThinking`, then the dispatching session's level. An agent that pins a model does **not**
inherit the session's thinking level, but a scoped model pin still follows that model.

`--model` accepts an optional `:<level>` suffix, so frontmatter can pin both at once:

```markdown
---
name: recon
aliases: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
thinking: low
---
```

The suffix is only split off when the tail is a real thinking level, so model ids that
contain a colon (`llama3:8b`) are left alone.

### Which models are offered

The `model` enum is built at registration time from `ctx.scopedModels` when the session has a
scope configured through `--models` or `enabledModels`. That is the same list Pi shows through
`/scoped-models`. A non-empty scope is also enforced at execution time, so an agent's
frontmatter cannot bypass it by pinning a model that the enum does not offer.

When `ctx.scopedModels` is empty, the session is unscoped and the enum uses every model in
`ctx.modelRegistry.getAvailable()`, across all providers. Configuring a scope is therefore useful
for keeping very large provider catalogues out of the subagent schema:

```bash
pi --models "gpt-5.6-*"
```

The enum is rebuilt on `session_start` (which also covers `/new`, `/resume`, `/fork` and
`/reload`) and on `model_select`. After changing provider authentication or model scope, run
`/reload` to rebuild it.

### Which thinking levels are offered

Thinking support is per model. pi describes it with `thinkingLevelMap`, where a `null` marks
a level unsupported and a missing key means the level works up to `high` but leaves `xhigh`
and `max` unsupported. A model with `reasoning: false` supports only `off`.

Because the model is chosen in the same call, the schema can only offer the union of levels
across the offered models. The real check happens before the subprocess is spawned, and what it
does depends on who asked. A level you passed on the call fails loudly, with the list of levels
that model does accept. A level that was merely inherited — from the agent's `thinking:`, from
`defaultThinking`, or from the session — is clamped down to the closest supported one instead,
the same way `maxThinking` clamps: the caller asked for work, not for a particular amount of
deliberation.

The map differs per provider for the same model id, so validation is keyed on `provider/id`.

### What the enum cannot know

The catalogue lists what a provider publishes, not what your account is entitled to use. A
model can be offered and still be rejected at run time, for example:

```
Error: Codex error: The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.
```

Nothing local can predict that, so the provider's error is surfaced as-is. The extension does
not automatically retry or substitute another model. Narrow the enum with `--models` or
`enabledModels` once you know which models your account actually accepts.

## Sample agents

| Agent | For | Tools |
|-------|-----|-------|
| `general-purpose` | Anything open-ended: investigate, then act | full |
| `recon` | Fast codebase recon, returns compressed findings | read, grep, find, ls, bash (investigation only) |
| `reviewer` | Evidence-based review without modifying the target | read, grep, find, ls, bash (investigation only) |

None pins a model, so all three follow the session.

A subagent earns its place when the task is self-contained given a description — gathering facts,
reviewing a delimited change, or doing a delimited job. Planning is not: it wants the whole
conversation, which is exactly what an isolated context does not have, so the dispatching agent
should plan for itself. `recon` is kept because being focused and cheap is the point of it.
`reviewer` is separate because review requires judgement rather than neutral fact gathering; its
prompt stays generic and accepts caller-specific output contracts.

`recon` keeps Pi's focused `grep`, `find` and `ls` tools (`grep` uses ripgrep) and also has
`bash` for read-only git inspection, `ast-grep`, and existing verification commands those tools
cannot cover. It still receives neither `edit` nor `write`, and its prompt restricts shell use to
investigation. This is a behavioral guard, not a security sandbox — shell itself can mutate files
— so use `general-purpose` whenever mutation is intended. The prompt names `ast-grep` explicitly
because `sg` on Linux is util-linux's setgid utility and calling it does something unrelated
instead of failing.

## Nudging the caller

Omitting `model` is the documented default, and a full-tool agent is the obvious thing to
reach for, so left alone the caller will use the expensive agent on the expensive model even
for a read-only look around. The extension emits `promptGuidelines` covering both choices:

```
Prefer an available specialist when its description directly matches the task. Otherwise, call
the subagent tool with agent: "recon" for neutral read-only investigation — searching, listing,
reading or summarising. Reserve the full-tool agents for work that must actually change something.

For that read-only work, also pass a cheaper model to the subagent tool: its model parameter
lists models cheapest first.
```

No model is named, and no price ratio is quoted. Both pin the caller to one model, and a
catalogue entry is not proof the account may use it. Catalogue prices are list prices in any
case, which a subscription account may not be paying. Instead the `model` enum is ordered
cheapest first and the guideline says only that, which leaves the caller free to choose another
model on a later call when one is refused. The ordering and the agent names are computed at
registration time, so they follow the current scoped model list (or the available registry when
unscoped) and the agents actually on disk. An input price of zero is valid for free and local
models; only a missing price is unknown. Nothing is emitted unless an offered model is strictly
cheaper than the current one.

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
An authorized coordinator gets both directions: `contact_supervisor` points upward and `subagent`
points downward. A depth-2 grandchild gets only `contact_supervisor`; delegation stops at the hard
depth-2 ceiling.

When the parent has no UI there is nothing to ask, so no channel directory is created. The child
still has the tool — registration depends only on depth — but calling it returns an immediate
error telling it to proceed on its own judgement, rather than blocking until a timeout. A request that goes unanswered for ten minutes returns an
instruction to proceed and state the assumption, which is also what an unreachable operator gets.

## Detached runs

`async: true` on a single dispatch starts the child and returns a run id straight away:

```
{ agent: "general-purpose", task: "...", async: true }
  -> Started 4f2a9c31 (general-purpose), detached.

{ action: "status" }                      // every detached run this session
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
{ agent: "reviewer", task: "Review what changed" }           -> finds a fault
{ resume: "4f2a9c31", task: "The review found X. Fix it." }
```

`async: true` works with `resume` as well, detaching the revived child. `model`, `thinking`, `context` and `cwd` are rejected on a resume rather than ignored: a revived child keeps the contract it was
launched with, so silently dropping them would have been worse than refusing.

A run that is still in flight cannot be resumed — two children appending to one transcript
corrupts it — and a run whose session file has since disappeared reports `not resumable` rather
than launching against a path that is gone.

`resume` and `agent` are mutually exclusive. A revived child keeps its stored agent source,
model, thinking level, tool allowlist, cwd, skill-inheritance and project-context settings rather
than re-deriving them. This still works if the original agent definition is edited or removed.
Its retained system prompt is supplied again on every resumed process because pi session JSON
stores the transcript but not `--append-system-prompt`. A retained project agent remains subject
to the project-agent trust confirmation even if resumed with the default user scope.

Every dispatch reports its run id — a single run appends `(run 4f2a9c31)`, parallel tags each
task heading, and a chain lists `step N: run …` at the end — because three parallel tasks running
the same agent are otherwise indistinguishable, and resuming the second of them is exactly the
case this exists for.

`{ action: "runs" }` lists retained and in-flight runs and says `resumable` or `not resumable` for each, which
is worth checking before building a plan around reviving one. A run with no retained session file
reports `not resumable`; start a fresh agent of the same role and say that it is a fallback.

This is why children no longer run `--no-session`. Each run gets a session under a retention root
belonging to this process, never the operator's session directory, and the whole root is deleted
on session shutdown. Retention is per parent session and does not survive a restart.

## Depth limit

A root process starts at depth 0. An ordinary depth-1 child gets the existing supervisor channel
but no delegation tool. An authorized coordinator is a depth-1 child with a valid runtime
contract; it may use that contract to make bounded, synchronous probes. Every grandchild is depth
2 and cannot register `subagent`: depth 2 is a hard ceiling on what the tool will register, not a
configurable setting. The gate uses exact depth and envelope validity, so a malformed, absent, or
inherited envelope cannot add a third level.

## Nested delegation

The depth gate above, the allowlist, the tool and model ceilings, and the spawn budget below are
enforcement for the `subagent` tool, not a guarantee about the coordinator process. They cover the
realistic failure modes: model confusion, runaway fan-out, misconfiguration, and prompt injection
that acts through the tool. They are not a sandbox: a coordinator whose own tools include `bash`
(or any other way to run a process) can read its depth and runtime envelope out of its environment
and launch `pi` directly with both rewritten, reaching a real depth 3, a forged budget, or a reset
spawn counter, none of which consults this gate. That was already true of any agent with shell
access before this feature existed, and remains true with it. For a coordinator without shell
access, every bound described here is real enforcement — that is the configuration to choose if
you need it to hold.

Delegation is opt-in per agent. The shipped `reviewer` is the coordinator example: it may send a
specific verification lookup to the builtin `recon` agent while keeping the review and its final
judgement in `reviewer`:

```yaml
# agents/reviewer.md
allowNestedSubagents: true
allowedSubagents: recon
```

`allowNestedSubagents` enables the coordinator path only when its allowlist resolves, and
`allowedSubagents` names the candidates it may call. Resolution is fail-closed: a coordinator
cannot delegate to itself, an absent or ambiguous name is dropped, a child with tools broader than
the coordinator's own tools is dropped, and nested model choices are intersected with the root's
model scope. Nested discovery uses the user/builtin scope, so a project-scoped agent cannot be
reached by the coordinator. The coordinator-side checks repeat the tool and model ceilings before
launch, so edits after root validation cannot widen the run.

A user-installed package that declares an agent with the same name as a delegate — the builtin
`recon`, say — takes precedence over it: agent discovery resolves builtins first and package
agents after, so the package's file wins outright. The coordinator's tool description names the
provenance of any non-builtin delegate for exactly this reason; a builtin needs no such note.

The two nested settings live under `subagents` in user settings. `maxNestedSpawns` accepts an
integer from `0` through `16`, defaults to `4`, and `0` disables nesting entirely.
`maxNestedConcurrency` accepts an integer from `1` through `8` and defaults to `2`. A trusted
project may lower either limit but cannot raise it; user settings are the authority for raising
them.

Nobody composes these with the parallel fan-out limits above, so here is the number that matters:
with every default left in place (`maxParallelTasks: 8`, `maxConcurrency: 4`, `maxNestedSpawns: 4`,
`maxNestedConcurrency: 2`), the worst case is the root process, plus up to 4 depth-1 children
running at once, plus up to 4 × 2 = 8 depth-2 grandchildren running at once if every one of those
depth-1 children happens to be a coordinator running its own parallel probes at its own
concurrency cap — **1 + 4 + 8 = 13 concurrent `pi` processes**, up from 5 without nesting. This
feature ships enabled by default, so that multiplier is worth knowing before raising either
fan-out limit or either nested limit.

That 13 is the ceiling for **one** `subagent` tool call, not for the session. A coordinator's tool
registers `executionMode: "sequential"`, so its own probes cannot multiply across simultaneous
calls; the root's tool deliberately does not, preserving existing behaviour. A model that emits
several root `subagent` calls in one turn therefore gets a separate fan-out budget for each, and
the true process ceiling is correspondingly higher. Neither limit is a global semaphore.

Authority is pinned at first launch, not at any launch. A run first launched while
`maxNestedSpawns` was `0` stores no contract, so re-enabling nesting later never grants it
delegation on resume — only a fresh launch can.

Coordinators run synchronously: `{ agent: "reviewer", task: "...", async: true }` is rejected so
its nested tree remains owned by the root call. Leaf agents such as `recon` still support detached
runs with `async: true`.

A coordinator is spawned with `detached: true` on POSIX, which makes it the leader of a new
process group and session rather than a member of the root's. Its whole subtree therefore sits
outside whatever process group or session the root belongs to: a terminal's Ctrl+C, a
`kill -- -$PGID` aimed at the root's group, or a process manager tearing a job down by process
group (systemd's `KillMode=control-group`, for example) will not reach it. The owner guard
described next is what makes that safe — every process in the subtree polls its owner and exits
on its own once the owner is gone, instead of relying on being reachable through the group or
session it left.

A nested child exits when the process that owns it disappears, detected by polling. If the owner's
process id is recycled by the operating system within the lifetime of a run, that check cannot tell
the difference and the child will not exit on its own. There is no portable fix: a process's start
time, which would disambiguate, is readable on Linux and not on macOS.

Termination has a narrower version of the same limitation: the escalation that follows an unresponsive
`SIGTERM` re-checks the process group rather than the coordinator itself, since the coordinator can
exit while a descendant lingers. On Linux this is narrower than it sounds: the kernel keeps a
process-group id allocated, and unavailable for reuse as anyone's pid, for as long as any member of
that group is still alive, so `kill(-pid, 0)` succeeding during the escalation is itself evidence
the group is still non-empty — and nothing outside this coordinator's own subtree ever joins that
group, so a non-empty result is still the original tree, not an unrelated one that happens to share
the number. The residual window this leaves is narrower than a plain reused-pid risk, and is
accepted.

## Frontmatter

| Field | Default | Effect |
|-------|---------|--------|
| `name` | — | Canonical name |
| `aliases` | none | Other names this agent answers to, matched case-insensitively |
| `description` | — | Shown to the dispatching model |
| `tools` | all | Tool allowlist. An explicit `[]` grants only the automatically added `contact_supervisor` channel, never pi's default tool set |
| `model` | inherit | Model, optionally with a `:<level>` thinking suffix |
| `thinking` | inherit | Thinking level, independent of the model spec |
| `inheritSkills` | `false` | Whether the child rediscovers pi's skill catalogue |
| `inheritProjectContext` | `true` | Whether the child loads `AGENTS.md` / `CLAUDE.md` from its cwd |
| `defaultContext` | `fresh` | `fork` makes this agent prefer a branched transcript, degrading to fresh when the parent has none |
| `suggest` | `true` | Whether the tool's guidance offers this agent as a general read-only choice. Set `false` for a specialist that expects a particular input |
| `allowNestedSubagents` | `false` | Whether this agent may coordinate bounded nested probes when its allowlist resolves |
| `allowedSubagents` | none | Candidate agent names for bounded nested probes; invalid, ambiguous, self, broader-tool, and out-of-scope candidates are dropped |

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
    "maxThinking": "high",
    "defaultContext": "fresh",
    "maxParallelTasks": 8,
    "maxConcurrency": 4,
    "maxNestedSpawns": 4,
    "maxNestedConcurrency": 2
  }
}
```

`defaultThinking` applies to agents that specify no thinking level of their own, independent of
the parent session's level. `maxThinking` is a ceiling: a request above it is clamped, not
rejected, because the caller asked for work rather than for a particular amount of deliberation.
Both are read fresh on each dispatch. User settings always apply. Project settings override
them only after pi has marked the parent project trusted, and only for child working directories
inside that trusted project's canonical root. This prevents an untrusted `.pi/settings.json` —
or an unrelated per-task `cwd` — from silently forcing context forking or changing budgets.
Within a trusted project the file is found by walking upward, so running pi from a subdirectory
still picks up the repository's settings. `defaultThinking`, `maxThinking` and `defaultContext`
resolve per child, against that child's own `cwd`; the two fan-out limits below govern the whole
call and resolve once, against the dispatching session's `cwd`.

### Parallel fan-out limits

`maxParallelTasks` is how many tasks one parallel call may submit; `maxConcurrency` is how many
children run at once within that call. They default to `8` and `4`. Each accepts a positive
integer or the string `"unbounded"`, which removes that limit:

```json
{
  "subagents": {
    "maxParallelTasks": "unbounded",
    "maxConcurrency": "unbounded"
  }
}
```

The two are independent: an unbounded task count with a finite concurrency still queues, and an
unbounded concurrency starts every submitted task immediately. Each child is a full `pi` process,
so an unbounded call spends tokens and machine resources in proportion to the list the model
writes — which is the point of making it an explicit choice rather than a default.

The aggregate result stays capped at pi's 50 KB / 2,000-line limits, and that cap is a head
truncation over the tasks in order. A large fan-out therefore drops the later tasks' text from
what the model reads, even though `details` keeps every transcript and the run ids stay
resumable. Retained child sessions also accumulate until the parent session shuts down.

Unlike the other settings, **only user settings may raise a limit**. A trusted project may lower
one and nothing more, and an untrusted project is ignored entirely. A repository is not an
authorization boundary for how many processes the machine runs, and a checkout that could raise
the limit would amplify anything that reaches the dispatching model through the files it reads.
A value that is neither a positive integer nor `"unbounded"` is ignored, falling back to the
default. Neither setting changes the hard depth-2 ceiling: only an authorized depth-1 coordinator may spawn, and no grandchild may spawn again.

## Agent definitions

Agent definitions are Markdown with YAML frontmatter, merged from four sources. Later sources
override earlier ones when they define the same name (matched case-insensitively), in this
precedence order:

1. **builtin** — bundled in this package's own `agents/` directory; always loaded.
2. **package** — declared by other installed Pi packages (see below); follows each package's own
   install scope.
3. **user** — `~/.pi/agent/agents/*.md`; always loaded.
4. **project** — `.pi/agents/*.md`; only with `agentScope: "project"` or `"both"`.

Every agent's `source` (one of `builtin`, `package`, `user`, `project`) is reported in tool result
headers, so it is always visible which of the four definitions ran.

```markdown
---
name: recon
aliases: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
thinking: low
---

System prompt for the agent goes here.
```

Omit `model` to inherit the dispatching session's model and thinking level. A malformed YAML
frontmatter document is skipped without preventing other valid agents in the directory from
being discovered.

### Package agents

An installed Pi package — including but not limited to `@emizuki/pi-code-review` — can expose its
own agent directories without any copy or symlink step, by declaring them under
`pi.subagents.agents` in its `package.json`:

```json
{
  "pi": {
    "subagents": {
      "agents": ["./agents"]
    }
  }
}
```

- Each entry is a directory path relative to the package root, read non-recursively for
  top-level `*.md` files in the same format as user and project agents. An absolute path, or one
  that escapes the package root, is ignored.
- A package entry with Pi's own `autoload: false` setting is skipped entirely; the first version
  of this contract has no separate filter for selecting individual agent directories.
- Package agents follow their package's own install scope, not a setting of their own: a
  user-scope install (plain `pi install`) is what makes them available at the default
  `agentScope: "user"`. A project-scope install (`pi install --local`) makes them need
  `agentScope: "project"` or `"both"`, the same as a `.pi/agents/*.md` file — but the two are not
  otherwise equivalent: `.pi/agents` is found by walking up from the session cwd to find the
  project root, while project-scoped package settings are read only at the session cwd exactly.
- A project-scoped package declaration is read only once Pi reports the project trusted; an
  untrusted project's package list contributes no agents. There is therefore nothing for the
  repo-controlled-agent confirmation to prompt about on a fresh dispatch of a project-scoped
  package agent — it is simply absent instead. That confirmation applies to `.pi/agents` project
  agent files (see Security), and to resuming a retained run backed by a project-scoped package
  agent whose project's trust has changed since the run was launched.
- A missing package installation, an unreadable or malformed `package.json`, a `subagents.agents`
  value that is not an array of strings, and any other malformed declaration are all skipped
  silently, the same as a malformed Markdown agent file — one broken package never hides agents
  from another source.
- An unreadable or malformed `settings.json` (either scope's) is different: it prints one
  diagnostic line naming the file to stderr, at most once per file path for the life of the
  process — not once per dispatch — so leaving it broken does not spam a live session. Fixing the
  file takes effect on the next dispatch even though the earlier diagnostic is not reprinted.

A package that currently relies on Pi's convention-based discovery for its other resources
(skills, prompts, extensions, themes) and adds a `pi` manifest key for the first time, purely to
declare `pi.subagents.agents`, must also declare those other resource directories explicitly in
the same manifest: Pi stops auto-discovering a package's resources by convention as soon as any
`pi` manifest key exists for it.

## Security

Each call runs a separate `pi` subprocess with a delegated system prompt and tool
configuration. Project-local agents — `.pi/agents/*.md` files and package agents installed at
project scope alike — are repo-controlled prompts that can instruct the model to read files and
run commands, so only user-level agents load by default. Pass `agentScope: "both"` for
repositories you trust. An untrusted project additionally prompts for confirmation, unless
`confirmProjectAgents: false` is set, before running a `.pi/agents` agent and before resuming a
retained run backed by a project-scoped package agent whose project has since become untrusted; a
project-scoped package agent is otherwise simply unavailable in an untrusted project rather than
prompted for on a fresh dispatch. Project `.pi/settings.json` is also repo-controlled and is
ignored until pi reports the project trusted.

## Limitations

- Collapsed view shows the last 10 items in single mode, 5 per step or task in chain and parallel; Ctrl+O expands.
- Every final tool result is capped globally at pi's 50 KB / 2,000-line limits, including the aggregate from parallel tasks. Full text remains in tool `details`, and truncation notices preserve resumable run ids.
- Agents are rediscovered on each invocation, so they can be edited mid-session.
- Parallel mode defaults to 8 tasks, 4 concurrent; raise or remove both in user settings.
- Removing the limits does not remove the depth limit: only an authorized depth-1 coordinator can dispatch nested probes; a grandchild cannot dispatch further.
- `maxNestedSpawns` counts nested probes inside one coordinator process, not across a logical unit of work: `resume` launches a new process with a fresh counter, so dispatching `reviewer` and then resuming it N more times can run up to `(N + 1) × maxNestedSpawns` probes in total rather than sharing one budget across the whole conversation.

## Checks

Install dependencies with `npm install`, then run `./check.sh` (or `npm run check`). The check
runs strict TypeScript validation against pinned development copies of pi's peer dependencies,
then executes the Node integration/regression suite.

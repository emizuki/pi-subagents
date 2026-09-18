# Task 7 report: The nested spawn budget

## What changed and why

- `extensions/subagents/dispatch.ts`
  - Added the module-private `nestedSpawnsUsed` counter. It is in-memory, process-local, incremented before dispatch, and never decremented, so a failed `spawn` attempt still consumes its claim for the coordinator's lifetime.
  - Added the test-only `__resetNestedSpawnBudget()` export. The counter itself remains private and is not reachable by the coordinator model.
  - Added whole-call admission after the coordinator's forbidden-key, allowlist, tool-ceiling, mode, and project-confirmation guards, immediately before the dispatch branches. A request is refused when its full task count exceeds the remaining budget; parallel calls are never partially admitted.
  - Skipped the root-only `maxParallelTasks` check for coordinator calls.
  - Used `Math.min(runtime.budget.maxConcurrency, requested)` for coordinator parallel dispatches. Root/non-coordinator dispatch keeps its existing behavior.
- `tests/nested-subagents.test.ts`
  - Added the required `beforeEach` reset so tests in this one `node --test` file do not share an exhausted module counter.
  - Added integration tests for cumulative admission, failed-spawn claims, atomic parallel refusal, nested concurrency, refused allowlist calls, and refused forbidden-key calls.
  - Added a root `maxParallelTasks` regression test so the coordinator path cannot accidentally use the root admission cap.
  - Set `process.argv[1]` to the existing bun-virtual fixture value through the shared `before()` hook, so the failed-spawn test's missing `PATH` actually reaches `spawn("pi", ...)` and its `error` handler.

All changes are scoped to the coordinator runtime path; root/non-coordinator dispatch behavior is unchanged.

## Verification

`npm run check` was run from this worktree at the final tree. Exact captured output:

```text

> @emizuki/pi-subagents@0.3.0 check
> npm run typecheck && npm test


> @emizuki/pi-subagents@0.3.0 typecheck
> tsc -p tsconfig.json


> @emizuki/pi-subagents@0.3.0 test
> node --test tests/*.test.ts

✔ discovers valid package agents when a sibling definition is malformed (11.170392ms)
✔ applies case-insensitive builtin package user project precedence (5.272302ms)
✔ ignores project package agents until the project is trusted (3.144034ms)
✔ project package definitions replace global package definitions (2.300124ms)
✔ a project-scoped package beats a same-named agent from an unrelated user-scoped package sharing its directory (2.39308ms)
✔ coordinator frontmatter parses the nested fields (2.128177ms)
✔ nested fields default off and grant nothing when not exactly true (1.911606ms)
✔ parseBoundedInt accepts only integers inside the range (1.334642ms)
✔ nested limits default when unset and when malformed (0.630106ms)
✔ a trusted project may lower the nested limits but never raise them (1.077934ms)
✔ envelope round-trips and rejects every malformed shape (1.046055ms)
✔ an empty allowedAgents array parses but grants nothing (0.310148ms)
✔ nested runtime and settings share budget bounds (0.412262ms)
✔ registration gate: the five depth and envelope states (27.965094ms)
✔ depth 2 refuses the very envelope depth 1 accepts (10.46806ms)
✔ an envelope with no allowed agents registers no subagent tool (4.662315ms)
✔ tool ceiling: a child may never exceed its coordinator (0.333423ms)
✔ allowlist resolution keeps survivors and reports every drop (0.587094ms)
✔ a coordinator that allow-lists only itself resolves to nothing (0.16391ms)
✔ self-reference is dropped by identity, not by spelling (0.172688ms)
✔ self-reference is dropped when names match across different files (0.223203ms)
✔ self-reference is dropped when file identity matches across different names (0.149433ms)
✔ resolution matches names and aliases case-insensitively (0.18426ms)
✔ resolution canonicalises an alias to the agent's real name (0.141258ms)
✔ duplicate names resolve once (0.203938ms)
✔ model ceiling intersects, preserves order, and distinguishes null from empty (0.283488ms)
✔ the coordinator schema cannot express the modes it must not use (0.383307ms)
✔ the nested model enum is the root's scope, not the local catalogue (0.596231ms)
✔ an empty model ceiling refuses rather than falling back to free-form (0.386483ms)
✔ nested registration leaves only contact_supervisor when the model ceiling is empty (4.833641ms)
✔ nested registration wires the model ceiling into the registered schema (1.680258ms)
✔ the counter stops a coordinator after maxSpawns (97.654428ms)
✔ a failed spawn still consumes its claim (10.249625ms)
✔ a parallel call over budget is rejected whole, before any child starts (2.531793ms)
✔ a coordinator's nested budget bypasses the root parallel admission cap (39.846435ms)
✔ nested parallel concurrency is min(maxConcurrency, remaining budget) (193.199512ms)
✔ a refused call consumes no budget (35.680061ms)
✔ a forbidden nested call consumes no budget (35.094179ms)
✔ a nested call carrying a forbidden key is refused (2.216165ms)
✔ a nested call naming an agent outside the allowlist is refused (1.643939ms)
✔ coordinator discovery never consults the process project-trust predicate (34.649435ms)
✔ a nested task cannot smuggle cwd through its item (2.623147ms)
✔ nested model validation leaves an unscoped root's model behavior unchanged (31.606984ms)
✔ nested model ceilings reject a leaf frontmatter model outside the root scope (2.648534ms)
✔ async detaches only agents with a live nested envelope (67.335737ms)
✔ a coordinator does not inherit trusted project subagent defaults (32.550734ms)
✔ an ordinary depth-1 child gets no envelope and no owner pid (33.825822ms)
✔ a coordinator receives an envelope naming exactly its resolved delegates (35.496131ms)
✔ a coordinator cannot be dispatched async from the root (3.610039ms)
✔ the coordinator re-checks the tool ceiling against the file it actually resolved (2.119171ms)
✔ maxNestedSpawns: 0 emits no envelope at all (35.021221ms)
✔ a coordinator whose allowlist resolves empty launches as an ordinary child (37.489253ms)
✔ a grandchild's environment carries no authority at all (966.997244ms)
✔ coordinator authority resolves against the user scope, not project shadows (37.017409ms)
✔ a resumed coordinator keeps its original allowlist after its agent file changes (66.922824ms)
✔ a run retained without a stored contract resumes with no delegation (34.681747ms)
✔ a resumed coordinator keeps its stored authority while nesting is disabled (100.116818ms)
✔ a depth-1 process emits no envelope for its own child (32.220056ms)
✔ resolves declared agent directories for configured npm, git, and local packages (5.80316ms)
✔ loads project packages declared at the exact session cwd only after project trust (0.988446ms)
✔ never reads an ancestor's .pi/settings.json for project packages, even when trusted (0.626729ms)
✔ orders every project-scoped directory after every user-scoped one, even when a directory is configured in both scopes (1.042938ms)
✔ excludes symlinks escaping the package root (0.810959ms)
✔ skips disabled, escaping, absolute, missing, and malformed package declarations (1.019514ms)
✔ skips malformed packages entries (null, a number, a boolean, an array, a sourceless object) and still resolves a valid entry (0.586203ms)
✔ an unreadable settings file logs one diagnostic naming it and still resolves the other scope (0.925245ms)
✔ a malformed settings file logs one diagnostic naming it and still resolves the other scope (0.752118ms)
✔ a malformed settings file logs its diagnostic at most once per file path across multiple discovery calls (0.520878ms)
✔ strips a UTF-8 BOM before parsing settings.json (0.662668ms)
✔ strips a UTF-8 BOM before parsing a package's package.json (0.568499ms)
✔ memoizes the legacy global-npm-root fallback across discovery calls in the same process (30.563996ms)
✔ a settings file edit invalidates the memoized install-path resolution (52.438675ms)
✔ does not accumulate package-manager cache entries across repeated settings edits to the same file (1.295327ms)
✔ a cached negative install-path result expires after its TTL and discovers a package installed in the meantime (0.599126ms)
✔ a cached positive install-path result has no TTL and survives well past the negative-result window (0.564971ms)
✔ a cached positive install-path result is dropped and re-resolved once its directory no longer exists (27.197929ms)
✔ bundled recon loads as a builtin without mutation tools (3.721461ms)
✔ bundled reviewer loads as a builtin and cannot mutate files (1.472935ms)
✔ user agent with same name as builtin overrides the builtin (1.31729ms)
✔ project agent with same name as builtin overrides the builtin (1.190849ms)
✔ invalid tool requests are structurally marked as errors (4.782503ms)
✔ Pi agent-core emits and serializes the bridged structural error (7.296713ms)
✔ untrusted project settings cannot force fork context (46.59566ms)
✔ trusted project settings still apply fork context (34.373542ms)
✔ a trusted parent cannot authorize settings from an unrelated task cwd (33.947554ms)
✔ single output is capped to Pi's byte limit while details retain the full message (37.90373ms)
✔ single output is capped to Pi's line limit (35.225298ms)
✔ parallel aggregate output is capped globally rather than once per task (77.218195ms)
✔ default settings keep the eight-task parallel cap (2.937011ms)
✔ default settings keep at most four children running at once (877.59307ms)
✔ user settings raise the parallel task limit (105.586225ms)
✔ user settings can remove the parallel task limit entirely (113.733181ms)
✔ user settings can remove the concurrency cap (656.043544ms)
✔ malformed limit settings fall back to the defaults (2.252403ms)
✔ a malformed concurrency setting falls back to the default cap (873.354149ms)
✔ trusted project settings lower a limit the user raised (2.92486ms)
✔ trusted project settings cannot raise the parallel task limit (2.798839ms)
✔ trusted project settings can lower the parallel task limit (2.874013ms)
✔ untrusted project settings cannot change the parallel task limit (36.094188ms)
✔ parallel results are structurally failed when any child fails (34.628997ms)
✔ truncation notices cannot exceed the global cap with long agent names (78.673937ms)
✔ status by id structurally reports a failed detached run (37.138277ms)
✔ signal-only child termination is a failed nonzero result (29.575399ms)
✔ aborting a child returns failed structured details instead of throwing (45.292597ms)
✔ empty tools is preserved as a restrictive allowlist (33.268656ms)
✔ malformed agent frontmatter is skipped without hiding valid agents (2.438647ms)
✔ model enum honors the configured session scope (1.790617ms)
✔ model enum uses every available provider when the session is unscoped (1.935131ms)
✔ free current model does not trigger cheaper-model guidance (1.895135ms)
✔ free available model triggers cheaper-model guidance for a paid current model (1.380279ms)
✔ scoped cheaper model triggers guidance when the current model is outside scope (1.283545ms)
✔ scoped model thinking pins are forwarded to the child (33.278424ms)
✔ agent frontmatter cannot select a model outside configured session scope (2.666448ms)
✔ scoped model matching uses Pi's case-insensitive canonical resolution (32.034295ms)
✔ resume uses the retained agent contract after the project agent file disappears (67.54802ms)
✔ retained project-agent trust cannot be bypassed by default resume scope (67.034476ms)
✔ a user-scoped package agent does not trigger the project-agent confirmation (35.00441ms)
✔ resuming a retained run backed by a project-scoped package agent is gated like a project agent (70.486776ms)
✔ stdout JSON decoding preserves UTF-8 split across chunks (55.705953ms)
✔ final output includes every text block from the last assistant message (33.791418ms)
✔ an empty final assistant message does not resurrect stale output (31.34074ms)
✔ contact_supervisor failures use Pi's structural error channel (6.989299ms)
ℹ tests 122
ℹ suites 0
ℹ pass 122
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4737.936775
```

The command exited 0. (The captured output above is the complete `npm run check` stream; timing values are intentionally preserved exactly as captured.)

## `any` count

The explicit TypeScript `any` scan was run against production `extensions/**/*.ts` before and after:

```text
pattern: (: any\b|<any>|Record<[^>]*\bany\b|\bany\[\])
HEAD explicit production any count: 3
WORKTREE explicit production any count: 3
```

The three pre-existing occurrences are unchanged:

- `extensions/subagents/format.ts:39` — `color: any`
- `extensions/subagents/results.ts:242` — `Record<string, any>`
- `extensions/subagents/run-agent.ts:442` — `event: any`

No `any` type was added by Task 7. A raw word scan over both `extensions` and `tests` changes from 41 to 42 only because the required test title contains the ordinary English word “any” in “before any child starts”; it is not a type annotation.

## Mutation table

Every listed mutant was applied, its targeted test was run, the test failed, and the original code was restored before final verification.

| Test | Mutation | Observed failure |
| --- | --- | --- |
| `the counter stops a coordinator after maxSpawns` | Replaced `if (requested > remaining)` with `if (false)`. | The third call returned fake `ok`; `/budget/` assertion failed. |
| `a failed spawn still consumes its claim` | Removed `nestedSpawnsUsed += requested`. | The retry launched and returned fake `ok` instead of a budget refusal. |
| `a parallel call over budget is rejected whole, before any child starts` | Limited the admission condition to `requested === 1`. | Four children started; `spawnCount` was 4 instead of 0. |
| `a coordinator's nested budget bypasses the root parallel admission cap` | Removed `!runtime` from the root `maxParallelTasks` guard. | The result was `Too many parallel tasks (2). Max is 1.` instead of two successes. |
| `nested parallel concurrency is min(maxConcurrency, remaining budget)` | Replaced nested concurrency with the root `maxConcurrency` expression. | Probe peak was 4 instead of 2. |
| `a refused call consumes no budget` | Added a claim before the not-callable allowlist return. | The legitimate follow-up was refused with zero budget remaining. |
| `a forbidden nested call consumes no budget` | Added a claim before the forbidden-key return. | The legitimate follow-up was refused with zero budget remaining. |
| The seven budget tests together | Replaced `beforeEach(() => __resetNestedSpawnBudget())` with a no-op. | Later tests observed an exhausted/negative remaining budget and failed, demonstrating the reset is not cosmetic. |

## Brief ambiguities or adaptations

- “The counter ... [is] not exported” and the required test-only reset export are technically in tension. I kept `nestedSpawnsUsed` private and exported only `__resetNestedSpawnBudget`, as the test contract requires.
- The brief snippets name helpers such as `dispatchNested`, while this fixture already used `executeNested` and did not have the concurrency helpers. I adapted the snippets to the existing fixture and added `envelopeWith`, `setConcurrencyProbe`, and `peakConcurrency` without changing production APIs.
- The concurrency wording says `min(maxConcurrency, remaining budget)`, while the required implementation expression uses `min(maxConcurrency, requested)`. Since whole-call admission requires `requested <= remaining`, these are equivalent for an admitted call; the implementation follows the required expression.
- The failed-spawn precondition was valid in this suite: the shared `before()` hook already sets `process.argv[1] = "/$bunfs/root/pi"`, so removing `pi` from `PATH` exercises the `spawn` error path rather than launching the test file with `process.execPath`.

## Unrelated defects and workspace items

- The three pre-existing production `any` annotations listed above remain untouched; removing them would be unrelated to Task 7.
- No unrelated code defects were observed or fixed.
- Pre-existing untracked workspace items (`AGENTS.md`, `docs/`, and `node_modules/`) were not staged.

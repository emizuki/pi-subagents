# Changelog

All notable changes to this project are documented here.

This project uses [semantic versioning](https://semver.org/). While the version
is below `1.0.0`, minor releases may contain breaking changes; those are always
listed first under **Breaking**.

## [0.4.0] - 2026-09-19

Bounded nested subagents: an authorized depth-1 coordinator may now delegate
verification probes to depth-2 leaves. Ships enabled by default for the
`reviewer` agent, which may delegate to `recon`.

### Breaking

- **`{ agent: "reviewer", async: true }` is now rejected.** Any agent that
  resolves to a working coordinator must run synchronously, so that its nested
  process tree stays owned by the root tool call. The call fails with
  `"reviewer" coordinates other agents and must run synchronously. Drop async.`
  Leaf agents such as `recon` are unaffected and still detach normally. To
  restore the old behaviour for `reviewer`, set `maxNestedSpawns: 0` (below) or
  remove `allowNestedSubagents` from the agent file.
- **`MAX_SUBAGENT_DEPTH` was removed** from `extensions/subagents/depth.ts`.
  Depth is now decided by the registration gate in `index.ts` rather than by a
  shared constant.

### Added

- Agent frontmatter fields `allowNestedSubagents` and `allowedSubagents`, which
  together authorize an agent to delegate and name the delegates it may use.
- Settings `maxNestedSpawns` (0–16, default 4) and `maxNestedConcurrency` (1–8,
  default 2). **`maxNestedSpawns: 0` is the kill switch** and disables nesting
  entirely, including the `async` rejection above.
- `agents/reviewer.md` now ships with `allowNestedSubagents: true` and
  `allowedSubagents: recon`.
- Authority is resolved in the root process before `spawn()` and passed to the
  child in a `PI_SUBAGENT_RUNTIME_V1` envelope: allowlist, tool ceiling, model
  ceiling and spawn budget. A delegate may not hold a tool the coordinator
  lacks, nor a model outside the root's scope.
- Coordinator subtrees are owned by process group and torn down with
  SIGTERM → grace → SIGKILL on POSIX, `taskkill /T /F` on Windows, with a
  pid-polling owner guard (`PI_SUBAGENT_OWNER_PID`) as backstop.
- Grandchild token usage now rolls into the root session's total.
- Delegation drops — a delegate that is missing, shadowed, or outside the
  coordinator's ceiling — are reported to both the operator and the model
  instead of failing silently.

### Changed

- The coordinator's `subagent` tool registers with
  `executionMode: "sequential"`, so `maxNestedConcurrency` is a real ceiling
  rather than a per-tool-call one. Root behaviour is unchanged.
- New child environment variables: `PI_SUBAGENT_RUNTIME_V1`,
  `PI_SUBAGENT_OWNER_PID`. Both are explicitly cleared for children that must
  not receive them.

### Operational notes

- **Process count.** With every default in place, one `subagent` tool call can
  reach 13 concurrent `pi` processes (1 root + 4 children + 4×2 grandchildren),
  up from 5. That is a per-call ceiling, not a global one.
- **These are bounds on the tool, not a sandbox.** They cover model confusion,
  runaway fan-out, misconfiguration and prompt injection acting through the
  tool. A coordinator whose own tools include `bash` can read its depth and
  envelope from its environment and launch `pi` directly with both rewritten.
  That was already true of any agent with shell access before this feature
  existed. For a coordinator without shell access, every bound is enforced.
- `detached: true` means a coordinator subtree leaves the root's process group
  and session, so teardown by process group (`kill -- -$PGID`, systemd
  `KillMode=control-group`) will not reach it; the owner guard covers this.
- The spawn budget is per process and per root tool call. It resets on resume.

### Known limitations

- Pid reuse defeats the owner guard; pgid reuse opens a window inside the
  SIGKILL grace period.
- Authority is pinned at a run's first launch, not at every launch.
- Delegation drops are not surfaced on the `chain` success path.
- A user-installed package declaring an agent named `recon` shadows the builtin.

## [0.3.0] and earlier

Released before this changelog was started; see the git history.

[0.4.0]: https://github.com/emizuki/pi-subagents/compare/8c4f3c0...v0.4.0

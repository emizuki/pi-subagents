import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { describeAgent, findAgent } from "./agent-select.ts";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { currentDepth, DEPTH_ENV_VAR } from "./depth.ts";
import { findScopedModel, isThinkingLevel, modelKey, type ModelLike, splitThinkingSuffix, supportedThinking, thinkingRank } from "./models.ts";
import { encodeNestedRuntime, OWNER_PID_ENV_VAR, resolveAllowedAgents, RUNTIME_ENV_VAR } from "./nested-runtime.ts";
import { coordinatorSpawnOptions, terminateOwnedTree } from "./process-tree.ts";
import { getFinalOutput, type SingleResult, type SubagentDetails } from "./results.ts";
import { findSessionFile, type RetainedRun, retainedRuns, retentionRoot, runsInFlight } from "./runs.ts";
import { sanitizeSessionForFork } from "./session-fork.ts";
import { type ForkContext, readSubagentSettings } from "./settings.ts";
import { drainSupervisorRequests, IPC_ENV_VAR, SUPERVISOR_POLL_MS, SUPERVISOR_TOOL, type SupervisorHandler } from "./supervisor.ts";

/** How long a child gets to exit on SIGTERM before SIGKILL. */
export const SIGKILL_GRACE_MS = 5_000;

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	// The directory is unique already. Keeping the untrusted agent name out of the file name also
	// avoids NAME_MAX failures for a valid but unusually long frontmatter name.
	const filePath = path.join(tmpDir, "prompt.md");
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	lookupModel?: (key: string) => ModelLike | undefined;
	/** Non-empty only when the parent configured --models/enabledModels. */
	scopedModels?: Array<{ model: ModelLike; thinkingLevel?: ThinkingLevel }>;
	/** Project settings already authorized by the parent session's trust decision. */
	trustedProjectSettings?: { file: string; root: string };
	/** The parent's session file, or undefined when this session is ephemeral. */
	parentSessionFile?: string;
	/** Answers the child's supervisor requests; absent when the parent cannot reach an operator. */
	supervise?: SupervisorHandler;
	/** Nested limits resolved once per dispatch, so every child does not re-read settings. */
	nested?: { maxSpawns: number; maxConcurrency: number };
}

export interface TaskOverrides {
	model?: string;
	thinking?: ThinkingLevel;
	context?: ForkContext;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
	if (!signal) return 1;
	const number = os.constants.signals[signal];
	return typeof number === "number" ? 128 + number : 1;
}

export async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	overrides: TaskOverrides,
	step: number | undefined,
	/** Retain this run's session under this id so it can be resumed, or revive an existing one. */
	retain: { id: string; resume?: RetainedRun } | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const resuming = retain?.resume;
	const discoveredAgent = resuming ? undefined : findAgent(agents, agentName);
	const agent: AgentConfig | undefined = resuming
		? {
				name: resuming.agent,
				aliases: [],
				description: "Retained subagent run",
				tools: resuming.tools,
				model: resuming.model,
				thinking: resuming.thinking,
				inheritSkills: resuming.inheritSkills,
				inheritProjectContext: resuming.inheritProjectContext,
				defaultContext: resuming.defaultContext,
				suggest: false,
				allowNestedSubagents: (resuming.allowedAgents?.length ?? 0) > 0,
				allowedSubagents: resuming.allowedAgents ?? [],
				systemPrompt: resuming.systemPrompt,
				source: resuming.agentSource,
				filePath: resuming.agentFilePath,
				packageScope: resuming.agentPackageScope,
				packageRoot: resuming.agentPackageRoot,
				packageName: resuming.agentPackageName,
			}
		: discoveredAgent;

	if (!agent) {
		const available = agents.map((a) => `"${describeAgent(a)}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p"];
	// Precedence: per-call override > agent frontmatter > dispatching session. Resolve an exact
	// model id before interpreting a trailing `:high`-style thinking suffix, because colons are
	// also legal inside model ids.
	const explicitSpec = resuming ? undefined : (overrides.model ?? agent.model);
	const exactScoped = explicitSpec ? findScopedModel(dispatchDefaults.scopedModels, explicitSpec) : undefined;
	const exactRegistered = explicitSpec ? dispatchDefaults.lookupModel?.(explicitSpec) : undefined;
	const explicit = explicitSpec
		? exactScoped
			? { model: modelKey(exactScoped.model) }
			: exactRegistered
				? { model: modelKey(exactRegistered) }
				: splitThinkingSuffix(explicitSpec)
		: undefined;
	const scopedSelection = explicit?.model ? findScopedModel(dispatchDefaults.scopedModels, explicit.model) : undefined;
	if (!resuming && explicit && dispatchDefaults.scopedModels?.length && !scopedSelection) {
		return {
			agent: agent.name,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: `Model "${explicit.model}" is outside the configured model scope. Available: ${dispatchDefaults.scopedModels.map((entry) => modelKey(entry.model)).join(", ")}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: explicit.model,
			step,
		};
	}
	const model = resuming
		? resuming.model
		: (scopedSelection ? modelKey(scopedSelection.model) : (explicit?.model ?? dispatchDefaults.model));

	const settings = readSubagentSettings(cwd ?? defaultCwd, dispatchDefaults.trustedProjectSettings);
	const frontmatterThinking = isThinkingLevel(agent.thinking) ? agent.thinking : undefined;
	// An explicit model does not inherit the session's thinking level, but a per-call `thinking`,
	// the agent's own `thinking:`, and a configured default all still apply.
	// A `:level` suffix on a per-call model is itself a per-call request, so it outranks the
	// agent's frontmatter; the same suffix written in frontmatter does not.
	const callSuffixThinking = overrides.model ? explicit?.thinking : undefined;
	const requestedThinking = overrides.thinking ?? callSuffixThinking;
	let thinking = resuming
		? resuming.thinking
		: (requestedThinking ??
			frontmatterThinking ??
			explicit?.thinking ??
			scopedSelection?.thinkingLevel ??
			settings.defaultThinking ??
			(explicit ? undefined : dispatchDefaults.thinkingLevel));

	// A ceiling is a budget control, so clamp rather than fail: the caller asked for work, not for
	// a particular amount of deliberation, and refusing the whole dispatch helps nobody.
	if (!resuming && thinking && settings.maxThinking && thinkingRank(thinking) > thinkingRank(settings.maxThinking)) {
		thinking = settings.maxThinking;
	}
	// pi clamps an unsupported thinking level silently, which is indistinguishable from the model
	// simply not thinking. Fail loudly instead so the caller can pick a level the model accepts.
	if (!resuming && thinking && model) {
		const resolved = dispatchDefaults.lookupModel?.(model);
		if (resolved) {
			const allowed = supportedThinking(resolved);
			if (!allowed.includes(thinking) && thinking !== requestedThinking) {
				// Inherited from frontmatter, settings or the session: clamp to the closest level the
				// model accepts, the same way maxThinking clamps, rather than failing a dispatch over
				// a value the caller never chose.
				const below = allowed.filter((level) => thinkingRank(level) <= thinkingRank(thinking as ThinkingLevel));
				thinking = below.length > 0 ? below[below.length - 1] : allowed[0];
			}
			if (thinking && !allowed.includes(thinking)) {
				return {
					agent: agentName,
					agentSource: agent.source,
					task,
					exitCode: 1,
					messages: [],
					stderr: `Model "${model}" does not support thinking level "${thinking}". Supported: ${allowed.join(", ")}.`,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					model,
					step,
				};
			}
		}
	}
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	// Collected here and flushed after the child exits (Step 7b). getResultOutput returns
	// `errorMessage || stderr`, so a delegation note written before the run would lead the model's
	// error text and bury the actual failure — and `currentResult` does not exist this far up.
	const delegationNotes: string[] = [];
	// Only the root decides authority. A coordinator running at depth 1 emits nothing, so its
	// grandchild cannot be handed a third level however the tree is arranged.
	const nestedLimits = dispatchDefaults.nested;
	const nestingEnabled = currentDepth() === 0 && nestedLimits !== undefined && nestedLimits.maxSpawns > 0;
	let envelope = "";
	let contract: { allowedAgents: string[]; toolCeiling: string[] | null; modelCeiling: string[] | null } | undefined;
	if (nestingEnabled) {
		if (resuming) {
			// Authority travels with the run, not with the file. An agent file edited between the
			// launch and the resume must not widen — or narrow — what was already granted.
			if (resuming.allowedAgents && resuming.allowedAgents.length > 0) {
				contract = {
					allowedAgents: resuming.allowedAgents,
					toolCeiling: resuming.toolCeiling ?? null,
					modelCeiling: resuming.modelCeiling ?? null,
				};
			}
		} else if (agent.allowNestedSubagents) {
			// `authorityAgents`, not the `agents` parameter. Task 4 Step 7 argues this at length: the
			// dispatch scope can contain project agents under `agentScope: "both"`, which would let a
			// checkout supply the very definition the tool ceiling is checked against.
			const authorityAgents = discoverAgents(cwd ?? defaultCwd, "user", { projectTrusted: false }).agents;
			const { allowed, dropped } = resolveAllowedAgents(agent, authorityAgents);
			for (const drop of dropped) delegationNotes.push(`Nested delegation: dropped "${drop.name}" — ${drop.reason}.`);
			if (allowed.length > 0) {
				contract = {
					allowedAgents: allowed,
					toolCeiling: agent.tools ?? null,
					modelCeiling: dispatchDefaults.scopedModels?.map((entry) => modelKey(entry.model)) ?? null,
				};
			} else {
				delegationNotes.push("Nested delegation: nothing survived, running as an ordinary agent.");
			}
		}
		if (contract) {
			envelope = encodeNestedRuntime({
				version: 1,
				depth: 1,
				agent: agent.name,
				...contract,
				budget: { maxSpawns: nestedLimits.maxSpawns, maxConcurrency: nestedLimits.maxConcurrency },
			});
		}
	}
	// An agent with an explicit allowlist would otherwise be unable to reach the channel at all.
	// A coordinator needs the delegation tool on its own allowlist, exactly as every restricted
	// agent needs the supervisor channel on it. --tools filters extension-registered tools too, so
	// omitting this registers `subagent` in the child and strips it on the same tick.
	const childTools = resuming
		? resuming.tools
		: agent.tools !== undefined
			? [...new Set([...agent.tools, SUPERVISOR_TOOL, ...(envelope ? ["subagent"] : [])])]
			: undefined;
	if (childTools !== undefined) args.push("--tools", childTools.join(","));
	// A child that rediscovers the whole skill catalogue pays for it on every dispatch, and the
	// task it was handed is narrower than the catalogue. Repository context is the opposite: a
	// delegated edit should respect the conventions of the repo it runs in.
	if (!agent.inheritSkills) args.push("--no-skills");
	if (!agent.inheritProjectContext) args.push("--no-context-files");

	// An explicit `context: "fork"` is a requirement and fails when it cannot be met. A fork coming
	// from frontmatter or settings is a preference and quietly runs fresh instead, so a missing
	// parent session never turns a configured default into a failed dispatch.
	const requestedContext = overrides.context;
	const effectiveContext = requestedContext ?? agent.defaultContext ?? settings.defaultContext ?? "fresh";
	// From the session manager, not the environment: PI_SESSION_FILE is injected into the commands
	// the bash tool runs, and is not set on pi's own process, so reading it here always found
	// nothing and made every explicit fork fail as "ephemeral".
	const parentSession = dispatchDefaults.parentSessionFile;
	const canFork = Boolean(parentSession && fs.existsSync(parentSession));
	if (effectiveContext === "fork" && !canFork && requestedContext === "fork") {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: parentSession
				? `context: "fork" needs the parent session file, but ${parentSession} is missing.`
				: 'context: "fork" needs a persisted parent session; this one is ephemeral.',
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model,
			step,
		};
	}
	const forking = effectiveContext === "fork" && canFork;

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let ipcDir: string | null = null;
	let forkSource: string | null = null;
	let supervisorTimer: ReturnType<typeof setInterval> | null = null;

	const currentResult: SingleResult = {
		// -1 until the process closes. The parallel view counts anything else as finished, and this
		// object is published live, so starting at 0 made a task read as done on its first message.
		exitCode: -1,
		runId: retain?.id,
		agent: agentName,
		agentSource: agent.source,
		task,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	if (retain) runsInFlight.add(retain.id);
	try {
		if (dispatchDefaults.supervise) {
			ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-ipc-"));
		}

		if (resuming) {
			// Revive the stored session in place; the launch contract came from the record, not
			// from re-resolving the agent, so the child picks up exactly where it left off.
			args.push("--session", resuming.sessionFile as string, "--session-dir", resuming.runDir);
		} else if (retain) {
			// Keep the child's session so a later pass can hand it a review finding. It lives under
			// this process's retention root, never the operator's session directory.
			const runDir = path.join(retentionRoot, retain.id);
			fs.mkdirSync(runDir, { recursive: true });
			if (forking && parentSession) {
				// Outside runDir: findSessionFile scans runDir for the child's own transcript, and a
				// child that died before writing one would otherwise have this copy retained as if it
				// were its session — a file the finally block then deletes.
				const source = path.join(retentionRoot, `${retain.id}.fork-source.jsonl`);
				sanitizeSessionForFork(parentSession, source);
				args.push("--fork", source);
				// pi reads this once at startup; the branch it writes is what gets retained.
				forkSource = source;
			}
			args.push("--session-dir", runDir);
		}

		// Session JSON stores messages and model state, not CLI append-system-prompt input, so the
		// retained prompt must be supplied again on every resumed process.
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				...(envelope ? coordinatorSpawnOptions() : {}),
				env: {
					...process.env,
					[DEPTH_ENV_VAR]: String(currentDepth() + 1),
					PI_SUBAGENT_AGENT: agent.name,
					// Explicitly cleared when not supervising: an inherited stale value would point the
					// child at a directory nobody polls, where it would wait out the full timeout.
					[IPC_ENV_VAR]: ipcDir ?? "",
					// Cleared for everyone who is not an authorized coordinator. A grandchild inheriting
					// its parent's envelope is precisely how depth 2 would become depth 3.
					[RUNTIME_ENV_VAR]: envelope,
					// An owner guard only for processes inside a coordinator subtree. Explicitly cleared
					// otherwise, like its two siblings above: an inherited stale value here is worse than
					// theirs, since startOwnerGuard treats a dead owner as process.exit(0) — a silent
					// success with truncated output — rather than merely losing a channel nobody polls.
					[OWNER_PID_ENV_VAR]: envelope || currentDepth() > 0 ? String(process.pid) : "",
				},
			});
			if (ipcDir && dispatchDefaults.supervise) {
				const dir = ipcDir;
				const handle = dispatchDefaults.supervise;
				let draining = false;
				supervisorTimer = setInterval(() => {
					// A reply can sit on a human for minutes; never start a second sweep over it.
					if (draining) return;
					draining = true;
					void drainSupervisorRequests(dir, handle)
						.catch(() => {
							// The scratch directory is removed as soon as the child exits, so a reply
							// that lands after a timeout fails here. That is expected, not fatal.
						})
						.finally(() => {
							draining = false;
						});
				}, SUPERVISOR_POLL_MS);
			}

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					// A nested subagent's tokens are spent in a process this one never sees; they arrive
					// here, on the coordinator's own tool result. Only the subagent tool rolls up —
					// counting every tool's usage would change the number reported for the many agents
					// that never delegate.
					if (msg.role === "toolResult" && msg.toolName === "subagent" && msg.usage) {
						currentResult.usage.input += msg.usage.input || 0;
						currentResult.usage.output += msg.usage.output || 0;
						currentResult.usage.cacheRead += msg.usage.cacheRead || 0;
						currentResult.usage.cacheWrite += msg.usage.cacheWrite || 0;
						currentResult.usage.cost += msg.usage.cost?.total || 0;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			// StringDecoder inside setEncoding carries incomplete multi-byte sequences across chunks.
			proc.stdout.setEncoding("utf8");
			proc.stderr.setEncoding("utf8");
			proc.stdout.on("data", (data: string) => {
				buffer += data;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: string) => {
				currentResult.stderr += data;
			});

			proc.on("close", (code, signalCode) => {
				if (buffer.trim()) processLine(buffer);
				if (signalCode && !wasAborted) {
					currentResult.errorMessage = `Child process terminated by ${signalCode}.`;
				}
				resolve(code ?? signalExitCode(signalCode));
			});

			proc.on("error", (error) => {
				// Without this the caller sees "Agent failed: (no output)" when `pi` is not on PATH.
				currentResult.stderr += `${currentResult.stderr ? "\n" : ""}Failed to start "${invocation.command}": ${error.message}`;
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					if (envelope) {
						terminateOwnedTree(proc, SIGKILL_GRACE_MS);
						return;
					}
					proc.kill("SIGTERM");
					// `killed` only means a signal was delivered, not that the process is gone, so it is
					// always true here and would make the escalation dead code. Exit state is the test.
					const escalate = setTimeout(() => {
						if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
					}, SIGKILL_GRACE_MS);
					escalate.unref?.();
					proc.once("exit", () => clearTimeout(escalate));
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (delegationNotes.length > 0) {
			// getResultOutput (results.ts) appends these to whichever text its errorMessage || stderr ||
			// output precedence picks, on both the success and failure paths, so they survive next to
			// the real reason a child failed instead of only showing up when that precedence happens to
			// land on `output`. Appending them to stderr as well used to outrank that same precedence
			// from this side: a child that exits non-zero with empty native stderr and no errorMessage
			// would then show only this note, discarding getFinalOutput(messages) — the actual reason it
			// failed.
			currentResult.outputNotes = delegationNotes;
		}
		if (wasAborted) {
			currentResult.stopReason = "aborted";
			currentResult.errorMessage = "Subagent was aborted.";
			if (currentResult.exitCode === 0) currentResult.exitCode = signalExitCode("SIGTERM");
		}
		if (retain) {
			const runDir = resuming ? resuming.runDir : path.join(retentionRoot, retain.id);
			const sessionFile = findSessionFile(runDir);
			retainedRuns.set(retain.id, {
				id: retain.id,
				agent: agent.name,
				agentSource: agent.source,
				agentFilePath: agent.filePath,
				agentPackageScope: agent.packageScope,
				agentPackageRoot: agent.packageRoot,
				agentPackageName: agent.packageName,
				model,
				thinking,
				tools: childTools,
				// Fall back to the stored values on a resume. Without the fallback, resuming while
				// maxNestedSpawns is 0 leaves `contract` undefined and erases the stored authority for
				// good — re-enabling nesting afterwards would not bring it back.
				allowedAgents: contract ? contract.allowedAgents : resuming?.allowedAgents,
				toolCeiling: contract ? contract.toolCeiling : resuming?.toolCeiling,
				modelCeiling: contract ? contract.modelCeiling : resuming?.modelCeiling,
				inheritSkills: agent.inheritSkills,
				inheritProjectContext: agent.inheritProjectContext,
				defaultContext: agent.defaultContext,
				systemPrompt: agent.systemPrompt,
				cwd: cwd ?? defaultCwd,
				runDir,
				sessionFile,
				// Without a session file there is nothing to revive, so say so rather than letting a
				// later resume discover it.
				resumable: Boolean(sessionFile),
			});
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		if (retain) runsInFlight.delete(retain.id);
		if (supervisorTimer) clearInterval(supervisorTimer);
		if (forkSource)
			try {
				fs.unlinkSync(forkSource);
			} catch {
				/* ignore */
			}
		if (ipcDir)
			try {
				fs.rmSync(ipcDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
	}
}

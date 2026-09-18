/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	formatSize,
	getAgentDir,
	getMarkdownTheme,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describeAgent, findAgent, isRepoControlledAgent, repoControlledSource } from "./agent-select.ts";
import {
	type AgentConfig,
	type AgentScope,
	type AgentSource,
	discoverAgents,
} from "./agents.ts";
import { currentDepth, DEPTH_ENV_VAR, MAX_SUBAGENT_DEPTH } from "./depth.ts";
import { formatToolCall, formatTokens, formatUsageStats } from "./format.ts";
import {
	findScopedModel,
	isThinkingLevel,
	modelChoices,
	modelKey,
	modelSchema,
	type ModelLike,
	splitModelKey,
	splitThinkingSuffix,
	supportedThinking,
	thinkingRank,
	thinkingSchema,
} from "./models.ts";
import {
	type DisplayItem,
	finalizeToolResult,
	getDisplayItems,
	getFailureText,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	isRunningResult,
	type SingleResult,
	type SubagentDetails,
	toolResultMetadata,
	type ToolResultDraft,
} from "./results.ts";
import {
	type DispatchDefaults,
	mapWithConcurrencyLimit,
	type OnUpdateCallback,
	runSingleAgent,
} from "./run-agent.ts";
import {
	abortAllAsyncRuns,
	type AsyncRun,
	asyncRuns,
	clearRetainedRuns,
	describeAsyncRun,
	findSessionFile,
	newRunId,
	type RetainedRun,
	retainedRuns,
	retentionRoot,
	runsInFlight,
	sweepStaleTempDirs,
	truncateForListing,
} from "./runs.ts";
import { sanitizeSessionForFork } from "./session-fork.ts";
import { type ForkContext, readSubagentSettings, trustedProjectSettings } from "./settings.ts";
import {
	drainSupervisorRequests,
	IPC_ENV_VAR,
	registerContactSupervisorTool,
	SUPERVISOR_POLL_MS,
	SUPERVISOR_TOOL,
	type SupervisorHandler,
} from "./supervisor.ts";

const COLLAPSED_ITEM_COUNT = 10;

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

/**
 * Without a nudge the model leaves `model` unset, because omitting it is the documented default.
 * Name the cheapest offered model explicitly so mechanical work has somewhere obvious to go.
 * Guidelines are appended flat to the prompt with no tool prefix, so each one names the tool.
 */
function buildGuidelines(choices: ModelLike[], currentModel: ModelLike | undefined, agents: AgentConfig[]): string[] {
	const guidelines: string[] = [];

	// Steering the agent choice matters more than the model: a full-tool agent on a read-only
	// task costs more and can write files the task never asked it to touch.
	const restricted = agents.filter(
		(a) => a.suggest && a.tools?.length && !a.tools.some((t) => t === "write" || t === "edit"),
	);
	if (restricted.length > 0 && agents.length > restricted.length) {
		const names = restricted.map((a) => `"${a.name}"`).join(" or ");
		guidelines.push(
			`Prefer an available specialist when its description directly matches the task. Otherwise, call the subagent tool with agent: ${names} for neutral read-only investigation — searching, listing, reading or summarising. Reserve the full-tool agents for work that must actually change something.`,
		);
	}

	// Deliberately nameless, and deliberately without a price ratio: both pin the caller to one
	// model. Catalogue prices are list prices anyway, which a subscription account may not pay.
	// Zero is a valid price for local and free models; only missing prices are unknown.
	const cheapest = choices.find((m) => m.cost?.input !== undefined);
	if (
		cheapest?.cost?.input !== undefined &&
		currentModel?.cost?.input !== undefined &&
		cheapest.cost.input < currentModel.cost.input
	) {
		guidelines.push(
			"For that read-only work, also pass a cheaper model to the subagent tool: its model parameter lists models cheapest first.",
			"Leave the subagent tool's model unset for work that needs judgement, such as planning, review or writing code; it then inherits the session's model.",
		);
	}

	return guidelines;
}

function makeSubagentParams(choices: ModelLike[], current: string | undefined) {
	const model = Type.Optional(modelSchema(choices, current));
	const thinking = Type.Optional(thinkingSchema(choices));
	const context = Type.Optional(
		StringEnum(["fresh", "fork"] as const, {
			description:
				'Child context. "fresh" (default) starts from the task alone; "fork" branches this session\'s transcript, which costs its input tokens on every turn.',
		}),
	);

	const TaskItem = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task to delegate to the agent" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		model,
		thinking,
		context,
	});

	const ChainItem = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		model,
		thinking,
		context,
	});

	return Type.Object({
		agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
		task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
		tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
		chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
		agentScope: Type.Optional(AgentScopeSchema),
		confirmProjectAgents: Type.Optional(
			Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
		),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
		model,
		thinking,
		context,
		async: Type.Optional(
			Type.Boolean({
				description:
					"Single mode only: start the run detached and return a run id immediately, instead of waiting for it.",
			}),
		),
		action: Type.Optional(
			StringEnum(["status", "stop", "runs"] as const, {
				description:
					'Inspect detached runs ("status", optionally with id), end one ("stop", with id), or list resumable runs ("runs").',
			}),
		),
		resume: Type.Optional(
			Type.String({
				description:
					"Run id to revive instead of starting a new child, with task as the follow-up. Mutually exclusive with agent; the revived child keeps its original agent, model and tools.",
			}),
		),
		id: Type.Optional(Type.String({ description: "Run id, for status or stop" })),
	});
}

function registerSubagentTool(pi: ExtensionAPI, ctx: ExtensionContext) {
	const current = ctx.model ? modelKey(ctx.model) : undefined;
	const choices = modelChoices(ctx);
	const discoveryOptions = { projectTrusted: ctx.isProjectTrusted() };
	const agents = discoverAgents(ctx.cwd, "user", discoveryOptions).agents;
	const SubagentParams = makeSubagentParams(choices, current);
	const promptGuidelines = buildGuidelines(choices, ctx.model, agents);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			agents.length > 0
				? `Available agents: ${agents.map(describeAgent).join(", ")}.`
				: `No agents found in ${path.join(getAgentDir(), "agents")}.`,
			`Default agent scope is "user": bundled agents, agents declared by user-installed packages, and ${path.join(getAgentDir(), "agents")}.`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		promptGuidelines,
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return finalizeToolResult(
				await (async (): Promise<ToolResultDraft<unknown>> => {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? modelKey(ctx.model) : undefined,
				thinkingLevel: ctx.thinkingLevel,
				scopedModels:
					ctx.scopedModels.length > 0
						? ctx.scopedModels.map(({ model, thinkingLevel }) => ({ model, thinkingLevel }))
						: undefined,
				trustedProjectSettings: ctx.isProjectTrusted() ? trustedProjectSettings(ctx.cwd) : undefined,
				parentSessionFile: ctx.sessionManager.getSessionFile(),
				lookupModel: (key) => {
					const parts = splitModelKey(key);
					return parts ? ctx.modelRegistry.find(parts.provider, parts.id) : undefined;
				},
				// Without a UI there is no operator to ask, so the channel is not offered at all
				// rather than handing children a question that can only time out.
				supervise: ctx.hasUI
					? async (request) => {
							if (request.reason === "progress_update") {
								ctx.ui.notify(`[${request.agent}] ${request.message}`, "info");
								return "";
							}
							const answer = await ctx.ui.input(`[${request.agent}] asks`, request.message);
							return (
								answer?.trim() ||
								"No answer from the operator. Proceed on your own judgement and state the assumption you made."
							);
						}
					: undefined,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope, {
				projectTrusted: ctx.isProjectTrusted(),
			});
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			if (params.action) {
				// Same shape as the async/resume rejections below: an action returns before any mode
				// runs, so a dispatch passed alongside one would be answered with a listing and
				// silently never executed.
				const dispatchKeys = (["agent", "task", "tasks", "chain", "resume", "async", "model", "thinking", "context"] as const).filter(
					(key) => params[key] !== undefined,
				);
				if (dispatchKeys.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: `action: "${params.action}" inspects runs and dispatches nothing, so ${dispatchKeys.join(", ")} would be ignored. Make the dispatch in its own call.`,
							},
						],
						failed: true,
					};
				}
			}

			if (params.action === "status") {
				const runs = params.id
					? [asyncRuns.get(params.id)].filter((r): r is AsyncRun => Boolean(r))
					: [...asyncRuns.values()];
				if (runs.length === 0) {
					const text = params.id ? `No run with id "${params.id}".` : "No detached runs in this session.";
					return { content: [{ type: "text", text }], failed: Boolean(params.id) };
				}
				// One run by id prints in full; the whole list is a summary, or a long session drops
				// every finished transcript into context at once.
				const rendered = params.id
					? runs.map((r) => describeAsyncRun(r))
					: runs.map((r) => truncateForListing(describeAsyncRun(r)));
				return {
					content: [{ type: "text", text: rendered.join("\n\n") }],
					failed: Boolean(params.id && runs[0].state === "failed"),
				};
			}

			if (params.action === "runs") {
				// A retained record only appears once the child exits, so an in-flight detached run
				// would otherwise be invisible here while `status` reports it running — two views of
				// the same run disagreeing, which reads as "that run does not exist".
				// Liveness first: a resumed run reuses its retained id, so a record exists while the
				// revived child is still going. Printing that record would call it resumable while
				// `status` calls it running — the disagreement this merge exists to remove.
				const lines = [...retainedRuns.values()].map((r) =>
					runsInFlight.has(r.id)
						? `${r.id}  ${r.agent}  still running, not resumable yet`
						: `${r.id}  ${r.agent}  ${r.resumable ? "resumable" : "not resumable"}${r.model ? `  ${r.model}` : ""}`,
				);
				for (const run of asyncRuns.values()) {
					if (run.state !== "running" || retainedRuns.has(run.id)) continue;
					lines.push(`${run.id}  ${run.agent}  still running, not resumable yet`);
				}
				if (lines.length === 0) {
					return { content: [{ type: "text", text: "No runs in this session yet." }] };
				}
				return { content: [{ type: "text", text: lines.join("\n") }] };
			}

			if (params.action === "stop") {
				const run = params.id ? asyncRuns.get(params.id) : undefined;
				if (!run) {
					return { content: [{ type: "text", text: `No run with id "${params.id ?? ""}".` }], failed: true };
				}
				if (run.state !== "running") {
					return { content: [{ type: "text", text: `Run ${run.id} already ${run.state}.` }] };
				}
				run.controller.abort();
				run.state = "stopped";
				run.finishedAt = Date.now();
				return { content: [{ type: "text", text: `Stopped ${run.id}.` }] };
			}

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean((params.agent || params.resume) && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			// These have to be rejected before the chain and parallel branches run, or those branches
			// answer first and the flag is silently dropped.
			if (params.async && (hasChain || hasTasks)) {
				return {
					content: [
						{
							type: "text",
							text: `async only applies to a single dispatch; ${hasChain ? "chain" : "parallel"} runs to completion in this call. To detach this work, start each task with its own async single dispatch and collect them with { action: "status" }.`,
						},
					],
					failed: true,
				};
			}

			if (params.resume && (hasChain || hasTasks)) {
				return {
					content: [
						{
							type: "text",
							text: `resume reviews one retained child, so it cannot be combined with ${hasChain ? "chain" : "parallel"}. Resume the run on its own, then continue.`,
						},
					],
					failed: true,
				};
			}

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
					failed: true,
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					// Must resolve aliases: this list drives the project-agent confirmation, and an
					// alias that failed to resolve here would run a repo-controlled prompt unprompted.
					.map((name) => findAgent(agents, name))
					.filter(isRepoControlledAgent);

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const sources = Array.from(
						new Set(projectAgentsRequested.map((a) => repoControlledSource(a, discovery.projectAgentsDir))),
					).join(", ");
					// A confirmation that cannot be asked has to deny. Previously the whole gate was
					// conditional on having a UI, so a headless session ran repo-controlled prompts
					// from an untrusted project with nothing asked and nothing said.
					if (!ctx.hasUI)
						return {
							content: [
								{
									type: "text",
									text: `Refused: ${names} come from ${sources} in a project that is not trusted, and this session cannot ask for confirmation. Trust the project, or pass confirmProjectAgents: false to accept that risk deliberately.`,
								},
							],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
							failed: true,
						};
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${sources}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
							failed: true,
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					// A function replacement, so `$&`, `$1` and friends in the previous output are inserted
					// literally instead of being expanded by String.replace.
					const taskWithContext = step.task.replace(/\{previous\}/g, () => previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						{
							model: step.model ?? params.model,
							thinking: step.thinking ?? params.thinking,
							context: step.context ?? params.context,
						},
						i + 1,
						{ id: newRunId() },
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							failed: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				const chainIds = results
					.map((r) => (r.runId ? `step ${r.step}: run ${r.runId} (${r.agent})` : undefined))
					.filter(Boolean)
					.join("\n");
				return {
					content: [
						{
							type: "text",
							text: `${getFinalOutput(results[results.length - 1].messages) || "(no output)"}${chainIds ? `\n\nResumable runs:\n${chainIds}` : ""}`,
						},
					],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				// The limits govern the whole call, so they follow the dispatching session's cwd rather
				// than any per-task cwd, which a caller could otherwise point at a permissive project.
				const { maxParallelTasks, maxConcurrency } = readSubagentSettings(
					ctx.cwd,
					dispatchDefaults.trustedProjectSettings,
				);
				if (maxParallelTasks !== "unbounded" && params.tasks.length > maxParallelTasks)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${maxParallelTasks}.`,
							},
						],
						details: makeDetails("parallel")([]),
						failed: true,
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter(isRunningResult).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const concurrency = maxConcurrency === "unbounded" ? params.tasks.length : maxConcurrency;
				const results = await mapWithConcurrencyLimit(params.tasks, concurrency, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						t.agent,
						t.task,
						t.cwd,
						{
							model: t.model ?? params.model,
							thinking: t.thinking ?? params.thinking,
							context: t.context ?? params.context,
						},
						undefined,
						{ id: newRunId() },
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = getResultOutput(r);
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					// Without the id a caller cannot resume one of several identical-looking tasks,
					// which is the whole point of retaining them.
					const id = r.runId ? ` run ${r.runId}` : "";
					return `### [${r.agent}]${id} ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
					failed: successCount !== results.length,
				};
			}

			if (params.resume && params.agent) {
				return {
					content: [
						{ type: "text", text: "Pass either resume or agent, not both: a revived child keeps its own contract." },
					],
					failed: true,
				};
			}

			let resumeTarget: RetainedRun | undefined;
			if (params.resume) {
				const target = retainedRuns.get(params.resume);
				if (!target) {
					const known = [...retainedRuns.keys()].join(", ") || "none";
					return {
						content: [{ type: "text", text: `No retained run "${params.resume}". Known runs: ${known}.` }],
						failed: true,
					};
				}
				if (runsInFlight.has(target.id)) {
					return {
						content: [
							{
								type: "text",
								text: `Run ${target.id} is still running. Two children appending to one session corrupts it; wait for it, or stop it first.`,
							},
						],
						failed: true,
					};
				}
				if (!target.resumable || !target.sessionFile || !fs.existsSync(target.sessionFile)) {
					return {
						content: [
							{
								type: "text",
								text: `Run ${target.id} is not resumable: no session was retained for it. Start a fresh ${target.agent} instead, and say that it is a fallback.`,
							},
						],
						failed: true,
					};
				}
				const ignored = [
					params.model ? "model" : undefined,
					params.thinking ? "thinking" : undefined,
					params.context ? "context" : undefined,
					params.cwd ? "cwd" : undefined,
				].filter(Boolean);
				if (ignored.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: `A resumed child keeps the contract it was launched with, so ${ignored.join(", ")} cannot be changed here. Drop ${ignored.length === 1 ? "it" : "them"}, or start a new child instead of resuming.`,
							},
						],
						failed: true,
					};
				}
				resumeTarget = target;
			}

			// Resume is source-based, not discovery-scope-based: a retained project prompt — including one
			// backed by a project-scoped package agent — stays project-controlled even when the caller omits
			// agentScope or the source file was removed.
			if (
				(resumeTarget?.agentSource === "project" || resumeTarget?.agentPackageScope === "project") &&
				confirmProjectAgents &&
				!ctx.isProjectTrusted()
			) {
				const dir = path.dirname(resumeTarget.agentFilePath);
				if (!ctx.hasUI) {
					return {
						content: [
							{
								type: "text",
								text: `Refused: retained run ${resumeTarget.id} uses project agent ${resumeTarget.agent} from ${dir}, and this session cannot ask for confirmation. Trust the project, or pass confirmProjectAgents: false to accept that risk deliberately.`,
							},
						],
						details: makeDetails("single")([]),
						failed: true,
					};
				}
				const ok = await ctx.ui.confirm(
					"Resume project-local agent?",
					`Agent: ${resumeTarget.agent}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				);
				if (!ok) {
					return {
						content: [{ type: "text", text: "Canceled: project-local agent resume not approved." }],
						details: makeDetails("single")([]),
						failed: true,
					};
				}
			}

			if ((params.agent || resumeTarget) && params.task && params.async) {
				const id = resumeTarget ? resumeTarget.id : newRunId();
				// Its own controller, never the tool call's: that signal fires the moment this call
				// returns, which for a detached run is immediately.
				const controller = new AbortController();
				const run: AsyncRun = {
					id,
					agent: params.agent ?? (resumeTarget?.agent as string),
					task: params.task,
					state: "running",
					startedAt: Date.now(),
					controller,
				};
				asyncRuns.set(id, run);

				void runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent ?? resumeTarget?.agent ?? "",
					params.task,
					resumeTarget ? resumeTarget.cwd : params.cwd,
					{ model: params.model, thinking: params.thinking, context: params.context },
					undefined,
					{ id, resume: resumeTarget },
					controller.signal,
					// No live rendering: this tool call is already over by the time output arrives.
					undefined,
					makeDetails("single"),
				)
					.then((result) => {
						if (run.state === "stopped") return;
						run.result = result;
						run.state = isFailedResult(result) ? "failed" : "complete";
					})
					.catch((error: unknown) => {
						if (run.state === "stopped") return;
						run.state = "failed";
						run.error = error instanceof Error ? error.message : String(error);
					})
					.finally(() => {
						run.finishedAt ??= Date.now();
					});

				return {
					content: [
						{
							type: "text",
							text: `Started ${id} (${run.agent}), detached. Check it with { action: "status", id: "${id}" }.`,
						},
					],
				};
			}

			if ((params.agent || resumeTarget) && params.task) {
				const singleRunId = resumeTarget ? resumeTarget.id : newRunId();
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent ?? resumeTarget?.agent ?? "",
					params.task,
					resumeTarget ? resumeTarget.cwd : params.cwd,
					{ model: params.model, thinking: params.thinking, context: params.context },
					undefined,
					{ id: singleRunId, resume: resumeTarget },
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						failed: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `${getFinalOutput(result.messages) || "(no output)"}${result.runId ? `\n\n(run ${result.runId})` : ""}`,
						},
					],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				failed: true,
				details: makeDetails("single")([]),
			};
				})(),
			);
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const candidate = result.details as Partial<SubagentDetails> | undefined;
			const details = candidate && Array.isArray(candidate.results) ? (candidate as SubagentDetails) : undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isRunningResult(r)
					? theme.fg("warning", "⏳")
					: isError
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					const failure = getFailureText(r);
					if (failure) container.addChild(new Text(theme.fg("error", `Error: ${failure}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				const failureText = getFailureText(r);
				if (failureText) text += `\n${theme.fg("error", `Error: ${failureText}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => !isFailedResult(r)).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isRunningResult(r)
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						// A spawn failure has neither tool calls nor output, so without this the
						// expanded view shows less than the collapsed one it was opened from.
						const rFailure = getFailureText(r);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (rFailure) container.addChild(new Text(theme.fg("error", `Error: ${rFailure}`), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = isRunningResult(r)
						? theme.fg("warning", "⏳")
						: isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					const stepFailure = getFailureText(r);
					if (stepFailure) text += `\n${theme.fg("error", `Error: ${stepFailure}`)}`;
					else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter(isRunningResult).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isRunningResult(r)
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						// A spawn failure has neither tool calls nor output, so without this the
						// expanded view shows less than the collapsed one it was opened from.
						const rFailure = getFailureText(r);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (rFailure) container.addChild(new Text(theme.fg("error", `Error: ${rFailure}`), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						isRunningResult(r)
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					const taskFailure = getFailureText(r);
					if (taskFailure) text += `\n${theme.fg("error", `Error: ${taskFailure}`)}`;
					else if (displayItems.length === 0)
						text += `\n${theme.fg("muted", isRunningResult(r) ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}

export default function (pi: ExtensionAPI) {
	// execute() cannot set AgentToolResult.isError because that field does not exist in Pi's API.
	// Bridge our private details marker onto the mutable tool_result event instead.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent" && event.toolName !== SUPERVISOR_TOOL) return;
		if (toolResultMetadata(event.details)?.failed) return { isError: true };
	});

	// Inside a spawned child the tool to offer is the one pointing back up, not the one pointing
	// further down: delegation stops at one level, but asking the operator does not.
	const register = (ctx: ExtensionContext) => {
		if (currentDepth() >= MAX_SUBAGENT_DEPTH) {
			registerContactSupervisorTool(pi);
			return;
		}
		registerSubagentTool(pi, ctx);
	};
	// The model enum is baked into the tool schema, so rebuild it whenever the catalogue behind it
	// can change: session start (also fires for /new, /resume and /fork) and model selection.
	pi.on("session_start", (_event, ctx) => {
		sweepStaleTempDirs();
		register(ctx);
	});
	pi.on("model_select", (_event, ctx) => register(ctx));

	// Detached children are separate processes: without this they survive /new, /resume, /fork and
	// exit, still burning tokens against a session nobody is watching any more.
	pi.on("session_shutdown", (_event, ctx) => {
		const stopped = abortAllAsyncRuns();
		if (stopped > 0 && ctx.hasUI) {
			ctx.ui.notify(`Stopped ${stopped} detached subagent run${stopped === 1 ? "" : "s"}.`, "info");
		}
		// A killed child has up to SIGKILL_GRACE_MS left and is still writing its session into the
		// retention root. Deleting it out from under a dying process only manufactures errors.
		// Synchronously, and only synchronously. The retention root is keyed on the process id, not
		// the session, and session_shutdown also fires for /new, /resume and /fork — so a delayed
		// sweep would delete the *next* session's root while its children were writing into it.
		// Whatever a dying child still writes lands in a directory that is already gone, which is
		// harmless; outliving the sweep and corrupting a live session is not.
		clearRetainedRuns();
		asyncRuns.clear();
	});
}

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { describeAgent, findAgent, isRepoControlledAgent, repoControlledSource } from "./agent-select.ts";
import { type AgentScope, discoverAgents } from "./agents.ts";
import { modelChoices, modelKey, splitModelKey } from "./models.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { finalizeToolResult, getFinalOutput, getResultOutput, isFailedResult, isRunningResult, type SingleResult, type SubagentDetails, type ToolResultDraft } from "./results.ts";
import { type DispatchDefaults, mapWithConcurrencyLimit, type OnUpdateCallback, runSingleAgent } from "./run-agent.ts";
import { type AsyncRun, asyncRuns, describeAsyncRun, newRunId, type RetainedRun, retainedRuns, runsInFlight, truncateForListing } from "./runs.ts";
import { buildGuidelines, makeSubagentParams } from "./schema.ts";
import { readSubagentSettings, trustedProjectSettings } from "./settings.ts";

export function registerSubagentTool(pi: ExtensionAPI, ctx: ExtensionContext) {
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

		renderCall: renderSubagentCall,
		renderResult: renderSubagentResult,
	});
}

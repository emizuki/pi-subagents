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
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/**
 * Why a result failed, for the collapsed views. A spawn failure (unknown agent, bad model id,
 * unsupported thinking level) only sets `stderr`, so rendering `errorMessage` alone leaves the
 * user staring at "(no output)" with no idea what went wrong.
 */
function getFailureText(result: SingleResult): string | undefined {
	if (!isFailedResult(result)) return undefined;
	const text = result.errorMessage || result.stderr?.trim();
	return text ? text.split("\n").slice(0, 3).join("\n") : undefined;
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
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

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
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

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	lookupModel?: (key: string) => ModelLike | undefined;
	/** Answers the child's supervisor requests; absent when the parent cannot reach an operator. */
	supervise?: SupervisorHandler;
}

/**
 * The child inherits this process's environment, so it also loads this extension and can call
 * the tool again. One level of delegation is useful; a tree of them multiplies cost silently.
 */
const DEPTH_ENV_VAR = "PI_SUBAGENT_DEPTH";
/** Directory the child writes supervisor requests into and reads replies from. */
const IPC_ENV_VAR = "PI_SUBAGENT_IPC_DIR";
/** A supervisor request waits on a human, so the ceiling is generous; it exists to avoid a hang. */
const SUPERVISOR_TIMEOUT_MS = 10 * 60_000;
const SUPERVISOR_POLL_MS = 250;
const SUPERVISOR_TOOL = "contact_supervisor";
const SUPERVISOR_REASONS = ["need_decision", "interview_request", "progress_update"] as const;
type SupervisorReason = (typeof SUPERVISOR_REASONS)[number];

interface SupervisorRequest {
	id: string;
	reason: SupervisorReason;
	message: string;
	agent: string;
}
const MAX_SUBAGENT_DEPTH = 1;

function currentDepth(): number {
	const raw = Number.parseInt(process.env[DEPTH_ENV_VAR] ?? "0", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

interface TaskOverrides {
	model?: string;
	thinking?: ThinkingLevel;
	context?: ForkContext;
}

/**
 * `--model` accepts an optional `:<thinking>` suffix (e.g. `sonnet:high`). Only split it off when
 * the tail is a real thinking level, so model ids that legitimately contain a colon (`llama3:8b`)
 * survive untouched.
 */
function splitThinkingSuffix(spec: string): { model: string; thinking?: ThinkingLevel } {
	const i = spec.lastIndexOf(":");
	if (i === -1) return { model: spec };
	const tail = spec.slice(i + 1);
	return (THINKING_LEVELS as readonly string[]).includes(tail)
		? { model: spec.slice(0, i), thinking: tail as ThinkingLevel }
		: { model: spec };
}

/**
 * Structural view of a model entry. `thinkingLevelMap` is documented for models.json but is not
 * part of the documented extension surface, so treat it as optional and degrade gracefully.
 */
interface ModelLike {
	provider: string;
	id: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	cost?: { input: number };
}

/**
 * Thinking levels a model actually accepts. Per pi-models.md: a missing key means the level works
 * through `high` but leaves `xhigh`/`max` unsupported; an explicit `null` means unsupported.
 */
function supportedThinking(model: ModelLike): ThinkingLevel[] {
	if (model.reasoning === false) return ["off"];
	const map = model.thinkingLevelMap;
	return THINKING_LEVELS.filter((level) => {
		const mapped = map?.[level];
		if (mapped === null) return false;
		if (mapped === undefined) return level !== "xhigh" && level !== "max";
		return true;
	});
}

/**
 * Resolve an agent by name or alias, case-insensitively. Callers reach for habitual names —
 * "general", "explorer", "Explore" — and an exact-match-only lookup turns that into a failed
 * dispatch instead of the agent the caller obviously meant.
 */
function findAgent(agents: AgentConfig[], wanted: string): AgentConfig | undefined {
	const needle = wanted.trim().toLowerCase();
	return (
		agents.find((a) => a.name.toLowerCase() === needle) ??
		agents.find((a) => a.aliases.some((alias) => alias.toLowerCase() === needle))
	);
}

function describeAgent(agent: AgentConfig): string {
	return agent.aliases.length > 0 ? `${agent.name} (aka ${agent.aliases.join(", ")})` : agent.name;
}

type ForkContext = "fresh" | "fork";

interface SubagentSettings {
	defaultThinking?: ThinkingLevel;
	maxThinking?: ThinkingLevel;
	defaultContext?: ForkContext;
}

/**
 * Copy a session transcript for forking, dropping provider-private reasoning blocks.
 *
 * A `thinkingSignature` names a reasoning item belonging to the response chain that produced it —
 * `rs_…` on OpenAI, a signed blob on Anthropic. Replayed from a branch it refers to something the
 * new chain never emitted, which providers reject. The child keeps its own thinking level and
 * reasons from its first turn, so removing the inherited blocks costs nothing.
 */
function isReasoningBlock(value: unknown): boolean {
	const type = (value as { type?: unknown } | null)?.type;
	return type === "thinking" || type === "redacted_thinking";
}

/**
 * Strip reasoning in place, anywhere it appears. Blocks do not only sit on `message.content`:
 * this tool stores each child's transcript under `message.details`, so a session that dispatched
 * subagents carries nested copies too. Walking the whole entry is the only way to be sure.
 */
function stripReasoning(node: unknown): number {
	let stripped = 0;
	if (Array.isArray(node)) {
		for (let i = node.length - 1; i >= 0; i--) {
			if (isReasoningBlock(node[i])) {
				node.splice(i, 1);
				stripped++;
			} else {
				stripped += stripReasoning(node[i]);
			}
		}
		return stripped;
	}
	if (node && typeof node === "object") {
		const record = node as Record<string, unknown>;
		if ("thinkingSignature" in record) {
			delete record.thinkingSignature;
			stripped++;
		}
		for (const value of Object.values(record)) stripped += stripReasoning(value);
	}
	return stripped;
}

/**
 * Copy a session transcript for forking, dropping provider-private reasoning.
 *
 * A `thinkingSignature` names a reasoning item belonging to the response chain that produced it —
 * `rs_…` on OpenAI, a signed blob on Anthropic. Replayed from a branch it refers to something the
 * new chain never emitted, which providers reject. The child keeps its own thinking level and
 * reasons from its first turn, so removing the inherited reasoning costs nothing.
 */
function sanitizeSessionForFork(sourceFile: string, destFile: string): number {
	const lines = fs.readFileSync(sourceFile, "utf8").split("\n");
	let stripped = 0;
	const out: string[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			// A half-written trailing line is normal for a session still being appended to.
			continue;
		}
		stripped += stripReasoning(entry);
		// An assistant turn whose only content was reasoning would replay as an empty message.
		const content = (entry as { message?: { content?: unknown } })?.message?.content;
		if (Array.isArray(content) && content.length === 0) continue;
		out.push(JSON.stringify(entry));
	}
	fs.writeFileSync(destFile, `${out.join("\n")}\n`, "utf8");
	return stripped;
}

/** Index into THINKING_LEVELS, which is ordered least to most thinking. */
function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function thinkingRank(level: ThinkingLevel): number {
	return THINKING_LEVELS.indexOf(level);
}

type SupervisorHandler = (request: SupervisorRequest) => Promise<string>;

type AsyncRunState = "running" | "complete" | "failed" | "stopped";

interface AsyncRun {
	id: string;
	agent: string;
	task: string;
	state: AsyncRunState;
	startedAt: number;
	finishedAt?: number;
	controller: AbortController;
	result?: SingleResult;
	error?: string;
}

/**
 * Detached runs for this session. Module state, which lives as long as the extension does, so a
 * run started in one tool call is still addressable from the next.
 */
const asyncRuns = new Map<string, AsyncRun>();

function describeAsyncRun(run: AsyncRun): string {
	const seconds = Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000);
	const usage = run.result ? formatUsageStats(run.result.usage, run.result.model) : "";
	const head = `${run.id}  ${run.state}  ${run.agent}  ${seconds}s${usage ? `  ${usage}` : ""}`;
	const task = run.task.length > 80 ? `${run.task.slice(0, 80)}…` : run.task;
	if (run.state === "running") return `${head}\n  task: ${task}`;
	const body = run.error ?? (run.result ? getResultOutput(run.result) : "(no output)");
	return `${head}\n  task: ${task}\n  ${body.split("\n").join("\n  ")}`;
}

/** Stop every live run. Children are separate processes and outlive the session otherwise. */
function abortAllAsyncRuns(): number {
	let stopped = 0;
	for (const run of asyncRuns.values()) {
		if (run.state !== "running") continue;
		run.controller.abort();
		run.state = "stopped";
		run.finishedAt = Date.now();
		stopped++;
	}
	return stopped;
}

/**
 * Parent-facing half: answer any requests the child has written, once.
 *
 * Replies are staged then renamed for the same reason requests are: the child polls for the file
 * and must not parse a partial one.
 */
async function drainSupervisorRequests(dir: string, handle: SupervisorHandler): Promise<void> {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".req.json")) continue;
		const requestPath = path.join(dir, entry);
		let request: SupervisorRequest;
		try {
			request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
		} catch {
			continue;
		}
		// Claim it before awaiting, so a slow answer is not handed out twice by the next poll.
		try {
			fs.renameSync(requestPath, `${requestPath}.claimed`);
		} catch {
			continue;
		}
		const answer = await handle(request);
		if (request.reason === "progress_update") continue;
		const replyPath = path.join(dir, `${request.id}.res.json`);
		fs.writeFileSync(`${replyPath}.partial`, JSON.stringify({ message: answer }), "utf8");
		fs.renameSync(`${replyPath}.partial`, replyPath);
	}
}

function modelKey(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

/** Split `provider/id` on the FIRST slash: ids themselves may contain slashes. */
function splitModelKey(key: string): { provider: string; id: string } | undefined {
	const i = key.indexOf("/");
	return i === -1 ? undefined : { provider: key.slice(0, i), id: key.slice(i + 1) };
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	overrides: TaskOverrides,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = findAgent(agents, agentName);

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
	// Precedence: per-call override > agent frontmatter > dispatching session.
	const explicitSpec = overrides.model ?? agent.model;
	const explicit = explicitSpec ? splitThinkingSuffix(explicitSpec) : undefined;
	const model = explicit?.model ?? dispatchDefaults.model;

	const settings = readSubagentSettings(cwd ?? defaultCwd);
	const frontmatterThinking = isThinkingLevel(agent.thinking) ? agent.thinking : undefined;
	// An explicit model does not inherit the session's thinking level, but a per-call `thinking`,
	// the agent's own `thinking:`, and a configured default all still apply.
	let thinking =
		overrides.thinking ??
		frontmatterThinking ??
		explicit?.thinking ??
		settings.defaultThinking ??
		(explicit ? undefined : dispatchDefaults.thinkingLevel);

	// A ceiling is a budget control, so clamp rather than fail: the caller asked for work, not for
	// a particular amount of deliberation, and refusing the whole dispatch helps nobody.
	if (thinking && settings.maxThinking && thinkingRank(thinking) > thinkingRank(settings.maxThinking)) {
		thinking = settings.maxThinking;
	}
	// pi clamps an unsupported thinking level silently, which is indistinguishable from the model
	// simply not thinking. Fail loudly instead so the caller can pick a level the model accepts.
	if (thinking && model) {
		const resolved = dispatchDefaults.lookupModel?.(model);
		if (resolved) {
			const allowed = supportedThinking(resolved);
			if (!allowed.includes(thinking)) {
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
	// An agent with an explicit allowlist would otherwise be unable to reach the channel at all.
	const childTools = agent.tools && agent.tools.length > 0 ? [...new Set([...agent.tools, SUPERVISOR_TOOL])] : undefined;
	if (childTools) args.push("--tools", childTools.join(","));
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
	const parentSession = process.env.PI_SESSION_FILE;
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
	let tmpSessionDir: string | null = null;
	let ipcDir: string | null = null;
	let supervisorTimer: ReturnType<typeof setInterval> | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
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

	try {
		if (dispatchDefaults.supervise) {
			ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-ipc-"));
		}

		if (forking && parentSession) {
			// Fork from a sanitized copy, and keep the branch in a scratch session dir so delegated
			// runs never show up in the operator's session list.
			tmpSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-fork-"));
			const source = path.join(tmpSessionDir, "parent.jsonl");
			sanitizeSessionForFork(parentSession, source);
			args.push("--fork", source, "--session-dir", tmpSessionDir);
		} else {
			args.push("--no-session");
		}

		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
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
				env: {
					...process.env,
					[DEPTH_ENV_VAR]: String(currentDepth() + 1),
					PI_SUBAGENT_AGENT: agent.name,
					...(ipcDir ? { [IPC_ENV_VAR]: ipcDir } : {}),
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
					void drainSupervisorRequests(dir, handle).finally(() => {
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
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
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
		if (supervisorTimer) clearInterval(supervisorTimer);
		if (tmpSessionDir)
			try {
				fs.rmSync(tmpSessionDir, { recursive: true, force: true });
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

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

/**
 * Models offered to the LLM as a per-call override. `ctx.scopedModels` is the user's own filter
 * (`--models` / `enabledModels`); when it is empty nothing is scoped, so fall back to the current
 * provider's catalogue rather than every provider pi knows about.
 */
function modelChoices(ctx: ExtensionContext): ModelLike[] {
	const scoped = ctx.scopedModels.map((s) => s.model);
	const pool =
		scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable().filter((m) => m.provider === ctx.model?.provider);
	const seen = new Set<string>();
	const unique = pool.filter((m) => !seen.has(modelKey(m)) && seen.add(modelKey(m)));
	// Cheapest first, unpriced last: the order is the only pricing signal the model gets, and
	// naming one model in a guideline would pin it to a choice its account may not even allow.
	return unique.sort((a, b) => (a.cost?.input ?? Number.POSITIVE_INFINITY) - (b.cost?.input ?? Number.POSITIVE_INFINITY));
}

function modelSchema(choices: ModelLike[], current: string | undefined) {
	const description = `Model for the subagent, ordered cheapest first. Omit to inherit the dispatching session's model${
		current ? ` (${current})` : ""
	}.`;
	const keys = choices.map(modelKey);
	// StringEnum needs a non-empty list; with nothing to choose from, accept a free-form id.
	return keys.length > 0
		? StringEnum(keys as [string, ...string[]], { description })
		: Type.String({ description });
}

/**
 * Thinking levels are per-model, but the model is picked in the same call, so the schema can only
 * offer the union across the offered models. `runSingleAgent` rejects a pair the resolved model
 * does not actually accept.
 */
function thinkingSchema(choices: ModelLike[]) {
	const union = THINKING_LEVELS.filter((level) => choices.some((m) => supportedThinking(m).includes(level)));
	const levels = union.length > 0 ? union : THINKING_LEVELS;
	return StringEnum(levels as unknown as [ThinkingLevel, ...ThinkingLevel[]], {
		description:
			"Thinking level for the subagent. Overrides a level pinned on the agent's model. Not every model accepts every level.",
	});
}

/**
 * Without a nudge the model leaves `model` unset, because omitting it is the documented default.
 * Name the cheapest offered model explicitly so mechanical work has somewhere obvious to go.
 * Guidelines are appended flat to the prompt with no tool prefix, so each one names the tool.
 */
function buildGuidelines(choices: ModelLike[], current: string | undefined, agents: AgentConfig[]): string[] {
	const guidelines: string[] = [];

	// Steering the agent choice matters more than the model: a full-tool agent on a read-only
	// task costs more and can write files the task never asked it to touch.
	const restricted = agents.filter((a) => a.tools?.length && !a.tools.some((t) => t === "write" || t === "edit"));
	if (restricted.length > 0 && agents.length > restricted.length) {
		const names = restricted.map((a) => `"${a.name}"`).join(" or ");
		guidelines.push(
			`Call the subagent tool with agent: ${names} whenever the task is read-only investigation — searching, listing, reading or summarising. Reserve the full-tool agents for work that must actually change something.`,
		);
	}

	// Deliberately nameless, and deliberately without a price ratio: both pin the caller to one
	// model. Catalogue prices are list prices anyway, which a subscription account may not pay.
	const priced = choices.filter((m) => (m.cost?.input ?? 0) > 0);
	const cheapest = priced[0];
	if (cheapest && modelKey(cheapest) !== current) {
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
			StringEnum(["status", "stop"] as const, {
				description: 'Inspect detached runs ("status", optionally with id) or end one ("stop", with id).',
			}),
		),
		id: Type.Optional(Type.String({ description: "Run id, for status or stop" })),
	});
}

/**
 * Child-facing half of the supervisor channel.
 *
 * A child that hits a real decision should be able to ask instead of guessing, and a guess is
 * indistinguishable from an answer once it reaches the parent as prose. Registered only inside a
 * spawned child, which is also the only place the tool could work: it needs the IPC directory the
 * parent created for that run.
 */
function registerContactSupervisorTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: SUPERVISOR_TOOL,
		label: "Contact supervisor",
		description: [
			"Ask the session that dispatched you, which can reach the operator.",
			"Use need_decision when a choice is genuinely the operator's to make and guessing would be wrong,",
			"interview_request when you need structured input, and progress_update to report a discovery that",
			"changes the plan without waiting for an answer.",
			"Do not ask when instructions merely look restrictive: a no-edit instruction simply wins.",
		].join(" "),
		parameters: Type.Object({
			reason: StringEnum(SUPERVISOR_REASONS, { description: "Why you are contacting the supervisor" }),
			message: Type.String({ description: "The question or update, self-contained: the supervisor has not seen your context" }),
		}),

		async execute(_toolCallId, params, signal) {
			const dir = process.env[IPC_ENV_VAR];
			if (!dir) {
				return {
					content: [{ type: "text", text: "No supervisor channel is available. Proceed on your own judgement and say what you assumed." }],
					isError: true,
				};
			}

			const id = randomUUID();
			const request: SupervisorRequest = {
				id,
				reason: params.reason as SupervisorReason,
				message: params.message,
				agent: process.env.PI_SUBAGENT_AGENT ?? "subagent",
			};
			// Write to a temp name first: the parent polls this directory and must never read a
			// half-written request.
			const finalPath = path.join(dir, `${id}.req.json`);
			const stagingPath = `${finalPath}.partial`;
			fs.writeFileSync(stagingPath, JSON.stringify(request), "utf8");
			fs.renameSync(stagingPath, finalPath);

			if (request.reason === "progress_update") {
				return { content: [{ type: "text", text: "Update delivered to the supervisor." }] };
			}

			const replyPath = path.join(dir, `${id}.res.json`);
			const deadline = Date.now() + SUPERVISOR_TIMEOUT_MS;
			while (Date.now() < deadline) {
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Aborted while waiting for the supervisor." }], isError: true };
				}
				if (fs.existsSync(replyPath)) {
					try {
						const reply = JSON.parse(fs.readFileSync(replyPath, "utf8")) as { message?: string };
						return { content: [{ type: "text", text: reply.message || "(empty reply)" }] };
					} catch {
						// Fall through and retry: the parent may still be writing.
					}
				}
				await new Promise((resolve) => setTimeout(resolve, SUPERVISOR_POLL_MS));
			}
			return {
				content: [{ type: "text", text: "The supervisor did not answer in time. Proceed on your own judgement and state the assumption you made." }],
				isError: true,
			};
		},
	});
}

function registerSubagentTool(pi: ExtensionAPI, ctx: ExtensionContext) {
	const current = ctx.model ? modelKey(ctx.model) : undefined;
	const choices = modelChoices(ctx);
	const agents = discoverAgents(ctx.cwd, "user").agents;
	const SubagentParams = makeSubagentParams(choices, current);
	const promptGuidelines = buildGuidelines(choices, current, agents);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			agents.length > 0
				? `Available agents: ${agents.map(describeAgent).join(", ")}.`
				: `No agents found in ${path.join(getAgentDir(), "agents")}.`,
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		promptGuidelines,
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? modelKey(ctx.model) : undefined,
				thinkingLevel: ctx.thinkingLevel,
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
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			if (params.action === "status") {
				const runs = params.id
					? [asyncRuns.get(params.id)].filter((r): r is AsyncRun => Boolean(r))
					: [...asyncRuns.values()];
				if (runs.length === 0) {
					const text = params.id ? `No run with id "${params.id}".` : "No detached runs in this session.";
					return { content: [{ type: "text", text }], isError: Boolean(params.id) };
				}
				return { content: [{ type: "text", text: runs.map(describeAsyncRun).join("\n\n") }] };
			}

			if (params.action === "stop") {
				const run = params.id ? asyncRuns.get(params.id) : undefined;
				if (!run) {
					return { content: [{ type: "text", text: `No run with id "${params.id ?? ""}".` }], isError: true };
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
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

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
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
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
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

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
						{ model: step.model, thinking: step.thinking, context: step.context },
						i + 1,
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
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
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
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						t.agent,
						t.task,
						t.cwd,
						{ model: t.model, thinking: t.thinking, context: t.context },
						undefined,
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
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task && params.async) {
				const id = randomUUID().slice(0, 8);
				// Its own controller, never the tool call\'s: that signal fires the moment this call
				// returns, which for a detached run is immediately.
				const controller = new AbortController();
				const run: AsyncRun = {
					id,
					agent: params.agent,
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
					params.agent,
					params.task,
					params.cwd,
					{ model: params.model, thinking: params.thinking, context: params.context },
					undefined,
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
							text: `Started ${id} (${params.agent}), detached. Check it with { action: "status", id: "${id}" }.`,
						},
					],
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					{ model: params.model, thinking: params.thinking, context: params.context },
					undefined,
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
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
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
			const details = result.details as SubagentDetails | undefined;
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
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
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
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
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
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

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
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
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
				const running = details.results.filter((r) => r.exitCode === -1).length;
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
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

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
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					const taskFailure = getFailureText(r);
					if (taskFailure) text += `\n${theme.fg("error", `Error: ${taskFailure}`)}`;
					else if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
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
	pi.on("session_start", (_event, ctx) => register(ctx));
	pi.on("model_select", (_event, ctx) => register(ctx));

	// Detached children are separate processes: without this they survive /new, /resume, /fork and
	// exit, still burning tokens against a session nobody is watching any more.
	pi.on("session_shutdown", (_event, ctx) => {
		const stopped = abortAllAsyncRuns();
		if (stopped > 0 && ctx.hasUI) {
			ctx.ui.notify(`Stopped ${stopped} detached subagent run${stopped === 1 ? "" : "s"}.`, "info");
		}
	});
}

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Agent, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Model,
	type ToolResultMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import extension from "../extensions/subagents/index.ts";
import { discoverAgents } from "../extensions/subagents/agents.ts";
import { writeFakePi } from "./fake-pi.ts";

const model = {
	provider: "test-provider",
	id: "cheap",
	name: "Cheap",
	reasoning: true,
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};
const expensiveModel = { ...model, id: "expensive", name: "Expensive", cost: { ...model.cost, input: 100 } };
const freeModel = {
	...model,
	provider: "local-provider",
	id: "free",
	name: "Free",
	cost: { ...model.cost, input: 0 },
};
const crossProviderModel = { ...expensiveModel, provider: "other-provider" };

type Handler = (...args: any[]) => any;

class ExtensionHarness {
	readonly handlers = new Map<string, Handler[]>();
	readonly tools = new Map<string, any>();
	readonly pi: any;

	constructor() {
		this.pi = {
			registerTool: (definition: any) => this.tools.set(definition.name, definition),
			on: (event: string, handler: Handler) => {
				const handlers = this.handlers.get(event) ?? [];
				handlers.push(handler);
				this.handlers.set(event, handlers);
			},
		};
		extension(this.pi);
	}

	async emit(event: string, payload: any, ctx: any): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx);
	}

	async register(ctx: any): Promise<any> {
		await this.emit("session_start", { reason: "startup" }, ctx);
		return this.tools.get("subagent");
	}

	async refresh(ctx: any): Promise<any> {
		await this.emit("model_select", {}, ctx);
		return this.tools.get("subagent");
	}

	async execute(
		params: Record<string, unknown>,
		ctx: any,
		signal: AbortSignal = new AbortController().signal,
	): Promise<any> {
		const tool = this.tools.get("subagent");
		assert.ok(tool, "subagent tool should be registered");
		return tool.execute("test-call", params, signal, undefined, ctx);
	}

	async applyToolResult(result: AgentToolResult<unknown>, ctx: any, toolName = "subagent"): Promise<any> {
		let event: any = {
			type: "tool_result",
			toolCallId: "test-call",
			toolName,
			input: {},
			content: result.content,
			details: result.details,
			isError: false,
		};
		for (const handler of this.handlers.get("tool_result") ?? []) {
			const update = await handler(event, ctx);
			if (update) event = { ...event, ...update };
		}
		return event;
	}

	async effectiveError(result: AgentToolResult<unknown>, ctx: any, toolName = "subagent"): Promise<boolean> {
		return (await this.applyToolResult(result, ctx, toolName)).isError;
	}
}

let root: string;
let agentDir: string;
let binDir: string;
let harness: ExtensionHarness;
const originalArgv1 = process.argv[1];
const originalPath = process.env.PATH;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalSubagentDepth = process.env.PI_SUBAGENT_DEPTH;
const originalSubagentOwner = process.env.PI_SUBAGENT_OWNER_PID;
const originalSubagentIpc = process.env.PI_SUBAGENT_IPC_DIR;
const originalSubagentAgent = process.env.PI_SUBAGENT_AGENT;

function writeAgent(
	dir: string,
	file: string,
	options: { name: string; tools?: string; model?: string; inheritProjectContext?: boolean },
): string {
	mkdirSync(dir, { recursive: true });
	const fields = [
		`name: ${options.name}`,
		`description: ${options.name} test agent`,
		options.tools === undefined ? undefined : `tools: ${options.tools}`,
		options.model ? `model: ${options.model}` : undefined,
		options.inheritProjectContext === false ? "inheritProjectContext: false" : undefined,
	].filter(Boolean);
	const target = path.join(dir, file);
	writeFileSync(target, `---\n${fields.join("\n")}\n---\nYou are a test agent.\n`);
	return target;
}

/** Scaffold a minimal Pi package declaring an agent directory through `pi.subagents.agents`,
 * mirroring the manifest contract `pi-code-review` depends on. */
function writePackageAgent(
	packageRoot: string,
	packageName: string,
	agentFile: string,
	options: { name: string; tools?: string },
): string {
	mkdirSync(packageRoot, { recursive: true });
	writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: packageName, pi: { subagents: { agents: ["./agents"] } } }),
	);
	return writeAgent(path.join(packageRoot, "agents"), agentFile, options);
}

function makeContext(
	cwd: string,
	overrides: {
		trusted?: boolean;
		scopedModels?: Array<{ model: typeof model; thinkingLevel?: string }>;
		availableModels?: Array<typeof model>;
		currentModel?: typeof model;
		parentSessionFile?: string;
		hasUI?: boolean;
	} = {},
): any {
	const available = overrides.availableModels ?? [model, expensiveModel];
	return {
		cwd,
		model: overrides.currentModel ?? model,
		thinkingLevel: "low",
		scopedModels: overrides.scopedModels ?? [],
		modelRegistry: {
			getAvailable: () => available,
			find: (provider: string, id: string) => available.find((item) => item.provider === provider && item.id === id),
		},
		sessionManager: { getSessionFile: () => overrides.parentSessionFile },
		hasUI: overrides.hasUI ?? false,
		isProjectTrusted: () => overrides.trusted ?? false,
		ui: {
			notify: () => {},
			input: async () => undefined,
			confirm: async () => true,
		},
	};
}

function setFakeMode(mode: string, captureFile: string, text = "ok"): void {
	process.env.FAKE_PI_MODE = mode;
	process.env.FAKE_PI_CAPTURE = captureFile;
	process.env.FAKE_PI_TEXT = text;
}

/** Make each child hold long enough that overlapping runs are observable in the probe file. */
function setConcurrencyProbe(captureFile: string, holdMs: number): void {
	process.env.FAKE_PI_CONCURRENCY_CAPTURE = captureFile;
	process.env.FAKE_PI_HOLD_MS = String(holdMs);
}

function clearConcurrencyProbe(): void {
	delete process.env.FAKE_PI_CONCURRENCY_CAPTURE;
	delete process.env.FAKE_PI_HOLD_MS;
}

/** Highest number of children alive at the same moment, from the probe's start/end events. */
function peakConcurrency(captureFile: string): number {
	if (!existsSync(captureFile)) return 0;
	let live = 0;
	let peak = 0;
	for (const event of readFileSync(captureFile, "utf8").trim().split("\n").filter(Boolean)) {
		if (event === "start") {
			live++;
			peak = Math.max(peak, live);
		} else {
			live--;
		}
	}
	return peak;
}

function writeUserSubagentSettings(subagents: Record<string, unknown>): void {
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents }));
}

function clearUserSubagentSettings(): void {
	const file = path.join(agentDir, "settings.json");
	if (existsSync(file)) unlinkSync(file);
}

function parallelTasks(count: number, label: string): Array<{ agent: string; task: string }> {
	return Array.from({ length: count }, (_, index) => ({ agent: "general-purpose", task: `${label} ${index}` }));
}

function captureArgs(captureFile: string): string[][] {
	if (!existsSync(captureFile)) return [];
	return readFileSync(captureFile, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function optionValue(args: string[], option: string): string | undefined {
	const index = args.indexOf(option);
	return index === -1 ? undefined : args[index + 1];
}

function resultText(result: any): string {
	const part = result.content.find((item: any) => item.type === "text");
	return part?.text ?? "";
}

before(async () => {
	root = mkdtempSync(path.join(tmpdir(), "pi-subagents-tests-"));
	agentDir = path.join(root, "agent-home");
	binDir = path.join(root, "bin");
	mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeAgent(path.join(agentDir, "agents"), "general-purpose.md", { name: "general-purpose" });
	writeAgent(path.join(agentDir, "agents"), "no-tools.md", { name: "no-tools", tools: "[]" });

	writeFakePi(binDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PATH = `${binDir}:${originalPath ?? ""}`;
	process.argv[1] = "/$bunfs/root/pi";
	delete process.env.PI_SUBAGENT_DEPTH;
	delete process.env.PI_SUBAGENT_OWNER_PID;
	delete process.env.PI_SUBAGENT_IPC_DIR;
	delete process.env.PI_SUBAGENT_AGENT;
	harness = new ExtensionHarness();
	await harness.register(makeContext(root));
});

after(async () => {
	await harness.emit("session_shutdown", {}, makeContext(root));
	process.argv[1] = originalArgv1;
	process.env.PATH = originalPath;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const [key, value] of [
		["PI_SUBAGENT_DEPTH", originalSubagentDepth],
		["PI_SUBAGENT_OWNER_PID", originalSubagentOwner],
		["PI_SUBAGENT_IPC_DIR", originalSubagentIpc],
		["PI_SUBAGENT_AGENT", originalSubagentAgent],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const key of [
		"FAKE_PI_MODE",
		"FAKE_PI_CAPTURE",
		"FAKE_PI_TEXT",
		"FAKE_PI_CWD_CAPTURE",
		"FAKE_PI_ENV_CAPTURE",
		"FAKE_PI_CONCURRENCY_CAPTURE",
		"FAKE_PI_HOLD_MS",
	])
		delete process.env[key];
	rmSync(root, { recursive: true, force: true });
});

test("bundled recon loads as a builtin without mutation tools", () => {
	const recon = discoverAgents(root, "user").agents.find((agent) => agent.name === "recon");
	assert.ok(recon);
	assert.equal(recon.source, "builtin");
	assert.deepEqual(recon.tools, ["read", "grep", "find", "ls", "bash"]);
	assert.ok(recon.aliases.includes("scout"));
	assert.equal(recon.tools.includes("edit"), false);
	assert.equal(recon.tools.includes("write"), false);
});

test("bundled reviewer loads as a builtin and cannot mutate files", () => {
	const reviewer = discoverAgents(root, "user").agents.find((agent) => agent.name === "reviewer");
	assert.ok(reviewer);
	assert.equal(reviewer.source, "builtin");
	assert.deepEqual(reviewer.aliases, ["review", "code-review", "auditor"]);
	assert.deepEqual(reviewer.tools, ["read", "grep", "find", "ls", "bash"]);
	assert.equal(reviewer.suggest, false);
	assert.equal(reviewer.tools.includes("edit"), false);
	assert.equal(reviewer.tools.includes("write"), false);
	assert.match(reviewer.systemPrompt, /never modify files/i);
});

test("user agent with same name as builtin overrides the builtin", () => {
	// The test fixture writes general-purpose.md to the user agent directory,
	// which shadows the builtin general-purpose.md.
	const result = discoverAgents(root, "user");
	const generalPurpose = result.agents.find((agent) => agent.name === "general-purpose");
	assert.ok(generalPurpose);
	assert.equal(generalPurpose.source, "user", "user agent should override builtin");
	// Verify exactly one general-purpose agent exists (no duplicates from different sources)
	const allMatching = result.agents.filter((agent) => agent.name.toLowerCase() === "general-purpose");
	assert.equal(allMatching.length, 1, "exactly one general-purpose agent should exist");
});

test("project agent with same name as builtin overrides the builtin", () => {
	const project = path.join(root, "override-project");
	const agentsDir = path.join(project, ".pi", "agents");
	writeAgent(agentsDir, "recon.md", { name: "recon" });
	const result = discoverAgents(project, "project");
	const recon = result.agents.find((agent) => agent.name === "recon");
	assert.ok(recon);
	assert.equal(recon.source, "project", "project agent should override builtin");
	// Verify exactly one recon agent exists
	const allMatching = result.agents.filter((agent) => agent.name.toLowerCase() === "recon");
	assert.equal(allMatching.length, 1, "exactly one recon agent should exist");
});

test("invalid tool requests are structurally marked as errors", async () => {
	const ctx = makeContext(root);
	await harness.refresh(ctx);
	const result = await harness.execute({ action: "status", id: "missing-run" }, ctx);
	assert.match(resultText(result), /No run/);
	assert.equal(await harness.effectiveError(result, ctx), true);
});

test("Pi agent-core emits and serializes the bridged structural error", async () => {
	const ctx = makeContext(root);
	await harness.refresh(ctx);
	const failedResult = await harness.execute({ action: "status", id: "missing-core-run" }, ctx);
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const loopModel = {
		id: "fake",
		name: "Fake",
		api: "openai-completions",
		provider: "fake",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 256,
	} satisfies Model<"openai-completions">;
	const tool: AgentTool<any> = {
		name: "subagent",
		label: "Subagent",
		description: "test bridge",
		parameters: Type.Object({}),
		execute: async () => failedResult,
	};
	const streamFn = async () => {
		const stream = createAssistantMessageEventStream();
		const start: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "fake",
			model: "fake",
			usage,
			stopReason: "pending",
			timestamp: Date.now(),
		};
		const toolCall = { type: "toolCall" as const, id: "core-call", name: "subagent", arguments: {} };
		const completed: AssistantMessage = { ...start, content: [toolCall], stopReason: "toolUse" };
		stream.push({ type: "start", partial: start });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: completed });
		stream.push({ type: "done", reason: "toolUse", message: completed });
		return stream;
	};
	const messages: any[] = [];
	const coreAgent = new Agent({
		initialState: { model: loopModel, thinkingLevel: "off", tools: [tool] },
		streamFn,
		afterToolCall: async ({ result }) => {
			const event = await harness.applyToolResult(result, ctx);
			return {
				content: event.content,
				details: event.details,
				isError: event.isError,
				terminate: true,
			};
		},
	});
	coreAgent.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "toolResult") messages.push(event.message);
	});
	await coreAgent.prompt("run the tool");
	const persisted = JSON.parse(JSON.stringify(messages[0]));
	assert.equal(persisted.isError, true);
	assert.match(persisted.content[0].text, /No run/);
	assert.equal(persisted.details.__piSubagents.failed, true);
});

test("Pi agent-core preserves usage on bridged tool results", async () => {
	const ctx = makeContext(root);
	await harness.refresh(ctx);
	const nested: Usage = {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
	};
	const loopModel = {
		id: "fake",
		name: "Fake",
		api: "openai-completions",
		provider: "fake",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 256,
	} satisfies Model<"openai-completions">;
	const parameters = Type.Object({});
	const tool: AgentTool<typeof parameters, undefined> = {
		name: "subagent",
		label: "Subagent",
		description: "test usage bridge",
		parameters,
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: undefined,
			usage: nested,
			terminate: true,
		}),
	};
	const streamFn = async () => {
		const stream = createAssistantMessageEventStream();
		const start: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "fake",
			model: "fake",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};
		const toolCall = { type: "toolCall" as const, id: "core-call", name: "subagent", arguments: {} };
		const completed: AssistantMessage = { ...start, content: [toolCall], stopReason: "toolUse" };
		stream.push({ type: "start", partial: start });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: completed });
		stream.push({ type: "done", reason: "toolUse", message: completed });
		return stream;
	};
	const messages: ToolResultMessage[] = [];
	const coreAgent = new Agent({
		initialState: { model: loopModel, thinkingLevel: "off", tools: [tool] },
		streamFn,
		afterToolCall: async ({ result }) => {
			const event = await harness.applyToolResult(result, ctx);
			return {
				content: event.content,
				details: event.details,
				isError: event.isError,
				terminate: true,
			};
		},
	});
	coreAgent.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "toolResult") messages.push(event.message);
	});
	await coreAgent.prompt("run the tool");
	assert.equal(messages.length, 1);
	assert.equal(messages[0].toolName, "subagent");
	assert.deepEqual(messages[0].usage, nested);
});

test("untrusted project settings cannot force fork context", async () => {
	const project = path.join(root, "untrusted-project");
	mkdirSync(path.join(project, ".pi"), { recursive: true });
	writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ subagents: { defaultContext: "fork" } }));
	const parentSession = path.join(root, "parent.jsonl");
	writeFileSync(parentSession, `${JSON.stringify({ type: "session", version: 3, id: "parent" })}\n`);
	const capture = path.join(root, "untrusted-capture.jsonl");
	setFakeMode("normal", capture);
	const ctx = makeContext(project, { trusted: false, parentSessionFile: parentSession });
	await harness.refresh(ctx);
	await harness.execute({ agent: "general-purpose", task: "test" }, ctx);
	assert.equal(captureArgs(capture)[0].includes("--fork"), false);
});

test("trusted project settings still apply fork context", async () => {
	const project = path.join(root, "trusted-project");
	mkdirSync(path.join(project, ".pi"), { recursive: true });
	writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ subagents: { defaultContext: "fork" } }));
	const parentSession = path.join(root, "trusted-parent.jsonl");
	writeFileSync(parentSession, `${JSON.stringify({ type: "session", version: 3, id: "parent" })}\n`);
	const capture = path.join(root, "trusted-capture.jsonl");
	setFakeMode("normal", capture);
	const ctx = makeContext(project, { trusted: true, parentSessionFile: parentSession });
	await harness.refresh(ctx);
	await harness.execute({ agent: "general-purpose", task: "test" }, ctx);
	assert.equal(captureArgs(capture)[0].includes("--fork"), true);
});

test("a trusted parent cannot authorize settings from an unrelated task cwd", async () => {
	const trustedProject = path.join(root, "trusted-parent-project");
	const unrelatedProject = path.join(root, "unrelated-task-project");
	mkdirSync(path.join(trustedProject, ".pi"), { recursive: true });
	mkdirSync(path.join(unrelatedProject, ".pi"), { recursive: true });
	writeFileSync(path.join(trustedProject, ".pi", "settings.json"), JSON.stringify({ subagents: {} }));
	writeFileSync(path.join(unrelatedProject, ".pi", "settings.json"), JSON.stringify({ subagents: { defaultContext: "fork" } }));
	const parentSession = path.join(root, "cross-project-parent.jsonl");
	writeFileSync(parentSession, `${JSON.stringify({ type: "session", version: 3, id: "parent" })}\n`);
	const capture = path.join(root, "cross-project-capture.jsonl");
	setFakeMode("normal", capture);
	const ctx = makeContext(trustedProject, { trusted: true, parentSessionFile: parentSession });
	await harness.refresh(ctx);
	await harness.execute({ agent: "general-purpose", task: "test", cwd: unrelatedProject }, ctx);
	assert.equal(captureArgs(capture)[0].includes("--fork"), false);
});

test("single output is capped to Pi's byte limit while details retain the full message", async () => {
	const capture = path.join(root, "large-capture.jsonl");
	setFakeMode("normal", capture, "x".repeat(70 * 1024));
	const ctx = makeContext(root);
	await harness.refresh(ctx);
	const result = await harness.execute({ agent: "general-purpose", task: "large" }, ctx);
	assert.ok(Buffer.byteLength(resultText(result), "utf8") <= 50 * 1024);
	assert.match(resultText(result), /^x+/);
	assert.match(resultText(result), /Output truncated/);
	assert.match(resultText(result), new RegExp(result.details.results[0].runId));
	assert.equal(result.details.results[0].messages[0].content[0].text.length, 70 * 1024);
});

test("single output is capped to Pi's line limit", async () => {
	const capture = path.join(root, "lines-capture.jsonl");
	setFakeMode("normal", capture, "line\n".repeat(2500));
	const ctx = makeContext(root);
	await harness.refresh(ctx);
	const result = await harness.execute({ agent: "general-purpose", task: "many lines" }, ctx);
	assert.ok(resultText(result).split("\n").length <= 2000);
	assert.match(resultText(result), /Output truncated/);
});

test("parallel aggregate output is capped globally rather than once per task", async () => {
	const capture = path.join(root, "parallel-large-capture.jsonl");
	setFakeMode("normal", capture, "p".repeat(12 * 1024));
	const ctx = makeContext(root);
	await harness.refresh(ctx);
	const result = await harness.execute(
		{
			tasks: Array.from({ length: 6 }, (_, index) => ({
				agent: "general-purpose",
				task: `parallel ${index}`,
			})),
		},
		ctx,
	);
	assert.ok(Buffer.byteLength(resultText(result), "utf8") <= 50 * 1024);
	assert.match(resultText(result), /Output truncated/);
	assert.equal(result.details.results.length, 6);
	assert.ok(result.details.results.every((item: any) => item.messages[0].content[0].text.length === 12 * 1024));
});

test("default settings keep the eight-task parallel cap", async () => {
	const capture = path.join(root, "default-cap-capture.jsonl");
	setFakeMode("normal", capture);
	const ctx = makeContext(root);
	await harness.refresh(ctx);
	const result = await harness.execute({ tasks: parallelTasks(9, "capped") }, ctx);
	assert.match(resultText(result), /Too many parallel tasks \(9\)\. Max is 8\./);
	assert.equal(await harness.effectiveError(result, ctx), true);
	assert.deepEqual(captureArgs(capture), []);
});

test("default settings keep at most four children running at once", async () => {
	const capture = path.join(root, "default-concurrency-capture.jsonl");
	const probe = path.join(root, "default-concurrency-probe.txt");
	setFakeMode("normal", capture);
	setConcurrencyProbe(probe, 400);
	try {
		const ctx = makeContext(root);
		await harness.refresh(ctx);
		const result = await harness.execute({ tasks: parallelTasks(6, "default concurrency") }, ctx);
		assert.equal(result.details.results.length, 6);
		// Root-side guard rail for dispatch.ts's parallel per-task summary: this output is far under
		// the truncation threshold, so the per-task " run <id>" mention is the only thing that can put
		// each task's run id into the text -- resumableRunSummary never runs without truncation.
		for (const r of result.details.results) {
			assert.match(
				resultText(result),
				new RegExp(r.runId),
				"each parallel task's run id must appear, so a root caller can resume any one of them",
			);
		}
		const peak = peakConcurrency(probe);
		assert.ok(peak > 1, `expected parallel execution, saw peak ${peak}`);
		assert.ok(peak <= 4, `expected the default cap to hold, saw peak ${peak}`);
	} finally {
		clearConcurrencyProbe();
	}
});

test("user settings raise the parallel task limit", async () => {
	const capture = path.join(root, "raised-cap-capture.jsonl");
	setFakeMode("normal", capture);
	try {
		writeUserSubagentSettings({ maxParallelTasks: 9 });
		const ctx = makeContext(root);
		await harness.refresh(ctx);
		const result = await harness.execute({ tasks: parallelTasks(9, "raised") }, ctx);
		assert.doesNotMatch(resultText(result), /Too many parallel tasks/);
		assert.equal(result.details.results.length, 9);
	} finally {
		clearUserSubagentSettings();
	}
});

test("user settings can remove the parallel task limit entirely", async () => {
	const capture = path.join(root, "unbounded-tasks-capture.jsonl");
	setFakeMode("normal", capture);
	try {
		writeUserSubagentSettings({ maxParallelTasks: "unbounded" });
		const ctx = makeContext(root);
		await harness.refresh(ctx);
		const result = await harness.execute({ tasks: parallelTasks(12, "unbounded") }, ctx);
		assert.doesNotMatch(resultText(result), /Too many parallel tasks/);
		assert.equal(result.details.results.length, 12);
	} finally {
		clearUserSubagentSettings();
	}
});

test("user settings can remove the concurrency cap", async () => {
	const capture = path.join(root, "unbounded-concurrency-capture.jsonl");
	const probe = path.join(root, "unbounded-concurrency-probe.txt");
	setFakeMode("normal", capture);
	setConcurrencyProbe(probe, 600);
	try {
		writeUserSubagentSettings({ maxConcurrency: "unbounded" });
		const ctx = makeContext(root);
		await harness.refresh(ctx);
		const result = await harness.execute({ tasks: parallelTasks(6, "unbounded concurrency") }, ctx);
		assert.equal(result.details.results.length, 6);
		// Beyond the default cap is the claim; pinning the exact peak would only measure how fast
		// this machine starts six Node processes.
		const peak = peakConcurrency(probe);
		assert.ok(peak > 4, `expected the cap to be lifted, saw peak ${peak}`);
	} finally {
		clearConcurrencyProbe();
		clearUserSubagentSettings();
	}
});

test("malformed limit settings fall back to the defaults", async () => {
	const capture = path.join(root, "malformed-limits-capture.jsonl");
	setFakeMode("normal", capture);
	try {
		writeUserSubagentSettings({ maxParallelTasks: 0, maxConcurrency: "lots" });
		const ctx = makeContext(root);
		await harness.refresh(ctx);
		const result = await harness.execute({ tasks: parallelTasks(9, "malformed") }, ctx);
		assert.match(resultText(result), /Max is 8\./);
	} finally {
		clearUserSubagentSettings();
	}
});

test("a malformed concurrency setting falls back to the default cap", async () => {
	const capture = path.join(root, "malformed-concurrency-capture.jsonl");
	const probe = path.join(root, "malformed-concurrency-probe.txt");
	setFakeMode("normal", capture);
	setConcurrencyProbe(probe, 400);
	try {
		writeUserSubagentSettings({ maxConcurrency: "lots" });
		const ctx = makeContext(root);
		await harness.refresh(ctx);
		const result = await harness.execute({ tasks: parallelTasks(6, "malformed concurrency") }, ctx);
		assert.equal(result.details.results.length, 6);
		const peak = peakConcurrency(probe);
		assert.ok(peak <= 4, `expected the default cap to hold, saw peak ${peak}`);
	} finally {
		clearConcurrencyProbe();
		clearUserSubagentSettings();
	}
});

test("trusted project settings lower a limit the user raised", async () => {
	const project = path.join(root, "limit-compose-project");
	mkdirSync(path.join(project, ".pi"), { recursive: true });
	writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ subagents: { maxParallelTasks: 2 } }));
	const capture = path.join(root, "limit-compose-capture.jsonl");
	setFakeMode("normal", capture);
	try {
		writeUserSubagentSettings({ maxParallelTasks: 9 });
		const ctx = makeContext(project, { trusted: true });
		await harness.refresh(ctx);
		const result = await harness.execute({ tasks: parallelTasks(3, "composed limits") }, ctx);
		assert.match(resultText(result), /Max is 2\./);
	} finally {
		clearUserSubagentSettings();
	}
});

test("trusted project settings cannot raise the parallel task limit", async () => {
	const project = path.join(root, "limit-raise-project");
	mkdirSync(path.join(project, ".pi"), { recursive: true });
	writeFileSync(
		path.join(project, ".pi", "settings.json"),
		JSON.stringify({ subagents: { maxParallelTasks: "unbounded" } }),
	);
	const capture = path.join(root, "limit-raise-capture.jsonl");
	setFakeMode("normal", capture);
	const ctx = makeContext(project, { trusted: true });
	await harness.refresh(ctx);
	const result = await harness.execute({ tasks: parallelTasks(9, "project raise") }, ctx);
	assert.match(resultText(result), /Max is 8\./);
});

test("trusted project settings can lower the parallel task limit", async () => {
	const project = path.join(root, "limit-lower-project");
	mkdirSync(path.join(project, ".pi"), { recursive: true });
	writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ subagents: { maxParallelTasks: 2 } }));
	const capture = path.join(root, "limit-lower-capture.jsonl");
	setFakeMode("normal", capture);
	const ctx = makeContext(project, { trusted: true });
	await harness.refresh(ctx);
	const result = await harness.execute({ tasks: parallelTasks(3, "project lower") }, ctx);
	assert.match(resultText(result), /Max is 2\./);
});

test("untrusted project settings cannot change the parallel task limit", async () => {
	const project = path.join(root, "limit-untrusted-project");
	mkdirSync(path.join(project, ".pi"), { recursive: true });
	writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ subagents: { maxParallelTasks: 1 } }));
	const capture = path.join(root, "limit-untrusted-capture.jsonl");
	setFakeMode("normal", capture);
	const ctx = makeContext(project, { trusted: false });
	await harness.refresh(ctx);
	const result = await harness.execute({ tasks: parallelTasks(2, "untrusted limit") }, ctx);
	assert.doesNotMatch(resultText(result), /Too many parallel tasks/);
	assert.equal(result.details.results.length, 2);
});

test("parallel results are structurally failed when any child fails", async () => {
	const capture = path.join(root, "parallel-failure-capture.jsonl");
	setFakeMode("normal", capture);
	const ctx = makeContext(root);
	await harness.refresh(ctx);
	const result = await harness.execute(
		{
			tasks: [
				{ agent: "general-purpose", task: "works" },
				{ agent: "missing-agent", task: "fails" },
			],
		},
		ctx,
	);
	assert.equal(result.details.results.filter((item: any) => item.exitCode !== 0).length, 1);
	assert.equal(await harness.effectiveError(result, ctx), true);
});

test("truncation notices cannot exceed the global cap with long agent names", async () => {
	const project = path.join(root, "long-agent-project");
	const agentsDir = path.join(project, ".pi", "agents");
	const tasks = Array.from({ length: 8 }, (_, index) => {
		const name = `long-${index}-${"n".repeat(1200)}`;
		writeAgent(agentsDir, `long-${index}.md`, { name });
		return { agent: name, task: `long name ${index}` };
	});
	const capture = path.join(root, "long-agent-capture.jsonl");
	setFakeMode("normal", capture, "p".repeat(10 * 1024));
	const ctx = makeContext(project, { trusted: true });
	await harness.refresh(ctx);
	const result = await harness.execute({ tasks, agentScope: "project" }, ctx);
	assert.ok(Buffer.byteLength(resultText(result), "utf8") <= 50 * 1024);
	assert.ok(resultText(result).split("\n").length <= 2000);
});

test("status by id structurally reports a failed detached run", async () => {
	const capture = path.join(root, "detached-failure-capture.jsonl");
	setFakeMode("sigkill", capture);
	const ctx = makeContext(root);
	await harness.refresh(ctx);
	const started = await harness.execute({ agent: "general-purpose", task: "die detached", async: true }, ctx);
	const id = /Started ([0-9a-f]+)/.exec(resultText(started))?.[1];
	assert.ok(id);
	let status: any;
	for (let attempt = 0; attempt < 30; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		status = await harness.execute({ action: "status", id }, ctx);
		if (/failed/.test(resultText(status))) break;
	}
	assert.match(resultText(status), /failed/);
	assert.equal(await harness.effectiveError(status, ctx), true);
});

test("signal-only child termination is a failed nonzero result", async () => {
	const capture = path.join(root, "sigkill-capture.jsonl");
	setFakeMode("sigkill", capture);
	const ctx = makeContext(root);
	await harness.refresh(ctx);
	const result = await harness.execute({ agent: "general-purpose", task: "die" }, ctx);
	assert.notEqual(result.details.results[0].exitCode, 0);
	assert.equal(await harness.effectiveError(result, ctx), true);
});

test("aborting a child returns failed structured details instead of throwing", async () => {
	const capture = path.join(root, "abort-capture.jsonl");
	setFakeMode("wait", capture);
	const ctx = makeContext(root);
	await harness.refresh(ctx);
	const controller = new AbortController();
	const pending = harness.execute({ agent: "general-purpose", task: "wait" }, ctx, controller.signal);
	setTimeout(() => controller.abort(), 40);
	const result = await pending;
	assert.ok(result.details.results[0]);
	assert.notEqual(result.details.results[0].exitCode, 0);
	assert.equal(await harness.effectiveError(result, ctx), true);
	assert.match(resultText(result), /aborted/i);
});

test("empty tools is preserved as a restrictive allowlist", async () => {
	const project = path.join(root, "empty-tools-project");
	const agentsDir = path.join(project, ".pi", "agents");
	writeAgent(agentsDir, "empty.md", { name: "empty", tools: "[]" });
	const discovery = discoverAgents(project, "project");
	const empty = discovery.agents.find((agent) => agent.name === "empty");
	assert.ok(empty);
	assert.deepEqual(empty.tools, []);

	const capture = path.join(root, "empty-tools-capture.jsonl");
	setFakeMode("normal", capture);
	const ctx = makeContext(root);
	await harness.refresh(ctx);
	await harness.execute({ agent: "no-tools", task: "restricted" }, ctx);
	assert.equal(optionValue(captureArgs(capture)[0], "--tools"), "contact_supervisor");
});

test("malformed agent frontmatter is skipped without hiding valid agents", () => {
	const project = path.join(root, "malformed-agent-project");
	const agentsDir = path.join(project, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(path.join(agentsDir, "broken.md"), "---\nname: [unterminated\ndescription: bad\n---\nbody\n");
	writeAgent(agentsDir, "valid.md", { name: "valid" });
	const discovery = discoverAgents(project, "project");
	const projectAgents = discovery.agents.filter((agent) => agent.source === "project");
	assert.deepEqual(projectAgents.map((agent) => agent.name), ["valid"]);
});

test("model enum honors the configured session scope", async () => {
	const ctx = makeContext(root, {
		scopedModels: [{ model, thinkingLevel: "high" }],
		availableModels: [model, crossProviderModel],
	});
	const tool = await harness.refresh(ctx);
	assert.deepEqual(tool.parameters.properties.model.enum, ["test-provider/cheap"]);
});

test("model enum uses every available provider when the session is unscoped", async () => {
	const ctx = makeContext(root, { availableModels: [model, crossProviderModel] });
	const tool = await harness.refresh(ctx);
	assert.deepEqual(tool.parameters.properties.model.enum, ["test-provider/cheap", "other-provider/expensive"]);
});

test("free current model does not trigger cheaper-model guidance", async () => {
	const ctx = makeContext(root, {
		currentModel: freeModel,
		availableModels: [freeModel, expensiveModel],
	});
	const tool = await harness.refresh(ctx);
	assert.equal(tool.promptGuidelines.some((line: string) => line.includes("pass a cheaper model")), false);
});

test("free available model triggers cheaper-model guidance for a paid current model", async () => {
	const ctx = makeContext(root, {
		currentModel: expensiveModel,
		availableModels: [expensiveModel, freeModel],
	});
	const tool = await harness.refresh(ctx);
	assert.equal(tool.promptGuidelines.some((line: string) => line.includes("pass a cheaper model")), true);
});

test("scoped cheaper model triggers guidance when the current model is outside scope", async () => {
	const ctx = makeContext(root, {
		currentModel: expensiveModel,
		scopedModels: [{ model: freeModel }],
		availableModels: [expensiveModel, freeModel],
	});
	const tool = await harness.refresh(ctx);
	assert.deepEqual(tool.parameters.properties.model.enum, ["local-provider/free"]);
	assert.equal(tool.promptGuidelines.some((line: string) => line.includes("pass a cheaper model")), true);
});

test("scoped model thinking pins are forwarded to the child", async () => {
	const capture = path.join(root, "thinking-capture.jsonl");
	setFakeMode("normal", capture);
	const ctx = makeContext(root, { scopedModels: [{ model, thinkingLevel: "high" }] });
	await harness.refresh(ctx);
	await harness.execute({ agent: "general-purpose", task: "think", model: "test-provider/cheap" }, ctx);
	assert.equal(optionValue(captureArgs(capture)[0], "--thinking"), "high");
});

test("agent frontmatter cannot select a model outside configured session scope", async () => {
	writeAgent(path.join(agentDir, "agents"), "pinned.md", {
		name: "pinned",
		model: "test-provider/expensive",
	});
	const capture = path.join(root, "scope-capture.jsonl");
	setFakeMode("normal", capture);
	const ctx = makeContext(root, { scopedModels: [{ model, thinkingLevel: "high" }] });
	await harness.refresh(ctx);
	const result = await harness.execute({ agent: "pinned", task: "expensive" }, ctx);
	assert.match(resultText(result), /outside the configured model scope/);
	assert.equal(await harness.effectiveError(result, ctx), true);
	assert.deepEqual(captureArgs(capture), []);
});

test("scoped model matching uses Pi's case-insensitive canonical resolution", async () => {
	writeAgent(path.join(agentDir, "agents"), "case-pinned.md", {
		name: "case-pinned",
		model: '" TEST-PROVIDER / CHEAP "',
	});
	const capture = path.join(root, "case-scope-capture.jsonl");
	setFakeMode("normal", capture);
	const ctx = makeContext(root, { scopedModels: [{ model, thinkingLevel: "high" }] });
	await harness.refresh(ctx);
	const result = await harness.execute({ agent: "case-pinned", task: "canonical" }, ctx);
	assert.equal(await harness.effectiveError(result, ctx), false);
	assert.equal(optionValue(captureArgs(capture)[0], "--model"), "test-provider/cheap");
});

test("resume uses the retained agent contract after the project agent file disappears", async () => {
	const project = path.join(root, "resume-project");
	const agentFile = writeAgent(path.join(project, ".pi", "agents"), "project-worker.md", {
		name: "project-worker",
		tools: "[read]",
		inheritProjectContext: false,
	});
	const capture = path.join(root, "resume-capture.jsonl");
	const cwdCapture = path.join(root, "resume-cwd.txt");
	setFakeMode("normal", capture);
	process.env.FAKE_PI_CWD_CAPTURE = cwdCapture;
	const ctx = makeContext(project, { trusted: true });
	await harness.refresh(ctx);
	const first = await harness.execute(
		{ agent: "project-worker", task: "first", agentScope: "project" },
		ctx,
	);
	const runId = first.details.results[0].runId;
	assert.ok(runId);
	unlinkSync(agentFile);
	ctx.model = expensiveModel;
	ctx.thinkingLevel = "off";
	const second = await harness.execute({ resume: runId, task: "second" }, ctx);
	delete process.env.FAKE_PI_CWD_CAPTURE;
	assert.doesNotMatch(resultText(second), /Unknown agent/);
	const calls = captureArgs(capture);
	assert.equal(calls.length, 2);
	assert.ok(calls[0].includes("--append-system-prompt"));
	assert.ok(calls[1].includes("--session"));
	assert.ok(calls[1].includes("--append-system-prompt"));
	assert.equal(optionValue(calls[1], "--model"), "test-provider/cheap");
	assert.equal(optionValue(calls[1], "--thinking"), "low");
	assert.equal(optionValue(calls[1], "--tools"), "read,contact_supervisor");
	assert.ok(calls[1].includes("--no-skills"));
	assert.ok(calls[1].includes("--no-context-files"));
	assert.deepEqual(readFileSync(cwdCapture, "utf8").trim().split("\n"), [project, project]);
});

test("retained project-agent trust cannot be bypassed by default resume scope", async () => {
	const project = path.join(root, "resume-trust-project");
	const agentFile = writeAgent(path.join(project, ".pi", "agents"), "trusted-worker.md", {
		name: "trusted-worker",
	});
	const capture = path.join(root, "resume-trust-capture.jsonl");
	setFakeMode("normal", capture);
	const trustedCtx = makeContext(project, { trusted: true });
	await harness.refresh(trustedCtx);
	const first = await harness.execute(
		{ agent: "trusted-worker", task: "first", agentScope: "project" },
		trustedCtx,
	);
	const runId = first.details.results[0].runId;
	unlinkSync(agentFile);
	const untrustedCtx = makeContext(project, { trusted: false, hasUI: false });
	const refused = await harness.execute({ resume: runId, task: "second" }, untrustedCtx);
	assert.match(resultText(refused), /Refused: retained run/);
	assert.equal(await harness.effectiveError(refused, untrustedCtx), true);
	assert.equal(captureArgs(capture).length, 1);
	const accepted = await harness.execute(
		{ resume: runId, task: "second", confirmProjectAgents: false },
		untrustedCtx,
	);
	assert.doesNotMatch(resultText(accepted), /Refused/);
	assert.equal(captureArgs(capture).length, 2);
});

// A fresh dispatch can never observe a project-scoped package agent that discovery found while
// the confirmation gate, moments later in the same synchronous call, sees the project as
// untrusted: project package settings are read only when `ctx.isProjectTrusted()` is true, and
// the gate's own check is a second call to that same, real (synchronous, no intervening await)
// predicate. Both calls happen in the same tick, so they cannot disagree outside a test fake that
// forces them to. Earlier revisions of this suite had two tests here ("...must be confirmed
// before it runs" and "...is refused without a UI to confirm it") that only exercised that
// unreachable combination, by hard-coding `isProjectTrusted()` to flip from true to false after
// exactly the two calls made during discovery — a call count private to today's implementation of
// `execute`. They were removed rather than kept passing against a fake trust engine. The resume
// path below is different and stays covered: a retained run's package provenance is fixed at
// launch, so trust genuinely can change relative to it within one session.

test("a user-scoped package agent does not trigger the project-agent confirmation", async () => {
	const packageRoot = path.join(agentDir, "npm", "node_modules", "user-vendor-agents");
	writePackageAgent(packageRoot, "user-vendor-agents", "user-vendor-worker.md", { name: "user-vendor-worker" });
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:user-vendor-agents"] }));
	const capture = path.join(root, "user-package-agent-capture.jsonl");
	setFakeMode("normal", capture);

	const ctx = makeContext(root, { trusted: false, hasUI: true });
	let confirmCalls = 0;
	ctx.ui.confirm = async () => {
		confirmCalls += 1;
		return true;
	};

	try {
		const result = await harness.execute(
			{ agent: "user-vendor-worker", task: "first", agentScope: "both" },
			ctx,
		);
		assert.equal(confirmCalls, 0, "a user-scoped package agent must not require confirmation");
		assert.doesNotMatch(resultText(result), /Refused|Canceled|Unknown agent/);
		assert.equal(captureArgs(capture).length, 1);
	} finally {
		rmSync(packageRoot, { recursive: true, force: true });
		clearUserSubagentSettings();
	}
});

test("resuming a retained run backed by a project-scoped package agent is gated like a project agent", async () => {
	const project = path.join(root, "package-agent-resume-project");
	const packageRoot = path.join(project, ".pi", "npm", "node_modules", "vendor-agents");
	writePackageAgent(packageRoot, "vendor-agents", "vendor-worker.md", { name: "vendor-worker" });
	writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:vendor-agents"] }));
	const capture = path.join(root, "package-agent-resume-capture.jsonl");
	setFakeMode("normal", capture);

	const trustedCtx = makeContext(project, { trusted: true });
	const first = await harness.execute({ agent: "vendor-worker", task: "first", agentScope: "both" }, trustedCtx);
	assert.doesNotMatch(resultText(first), /Refused|Unknown agent/);
	const runId = first.details.results[0].runId;
	assert.ok(runId);

	const untrustedCtx = makeContext(project, { trusted: false, hasUI: false });
	const refused = await harness.execute({ resume: runId, task: "second" }, untrustedCtx);
	assert.match(resultText(refused), /Refused: retained run/);
	assert.equal(await harness.effectiveError(refused, untrustedCtx), true);
	assert.equal(captureArgs(capture).length, 1);

	const accepted = await harness.execute(
		{ resume: runId, task: "second", confirmProjectAgents: false },
		untrustedCtx,
	);
	assert.doesNotMatch(resultText(accepted), /Refused/);
	assert.equal(captureArgs(capture).length, 2);
});

test("stdout JSON decoding preserves UTF-8 split across chunks", async () => {
	const capture = path.join(root, "utf8-capture.jsonl");
	setFakeMode("split-utf8", capture, "before🙂after");
	const ctx = makeContext(root);
	await harness.refresh(ctx);
	const result = await harness.execute({ agent: "general-purpose", task: "unicode" }, ctx);
	assert.match(resultText(result), /before🙂after/);
	assert.doesNotMatch(resultText(result), /�/);
});

test("final output includes every text block from the last assistant message", async () => {
	const capture = path.join(root, "multi-text-capture.jsonl");
	setFakeMode("multi-text", capture);
	const ctx = makeContext(root);
	await harness.refresh(ctx);
	const result = await harness.execute({ agent: "general-purpose", task: "multi" }, ctx);
	assert.match(resultText(result), /^firstsecond/);
	// Root-side guard rail for dispatch.ts's single-success run-id suffix: unlike the nested case,
	// a root caller needs this id to resume the child, and this output is short enough that it is
	// not truncated -- so, unlike the byte-limit test below, nothing but this suffix can supply it.
	assert.match(
		resultText(result),
		new RegExp(result.details.results[0].runId),
		"a non-truncated single dispatch must still show its run id, so a root caller can resume it",
	);
});

test("an empty final assistant message does not resurrect stale output", async () => {
	const capture = path.join(root, "empty-final-capture.jsonl");
	setFakeMode("empty-final", capture);
	const ctx = makeContext(root);
	await harness.refresh(ctx);
	const result = await harness.execute({ agent: "general-purpose", task: "empty final" }, ctx);
	assert.doesNotMatch(resultText(result), /stale/);
	assert.match(resultText(result), /^\(no output\)/);
});

test("contact_supervisor failures use Pi's structural error channel", async () => {
	const priorDepth = process.env.PI_SUBAGENT_DEPTH;
	const priorIpc = process.env.PI_SUBAGENT_IPC_DIR;
	try {
		process.env.PI_SUBAGENT_DEPTH = "1";
		delete process.env.PI_SUBAGENT_IPC_DIR;
		const childHarness = new ExtensionHarness();
		const ctx = makeContext(root);
		await childHarness.register(ctx);
		const tool = childHarness.tools.get("contact_supervisor");
		assert.ok(tool);
		const result = await tool.execute("contact-call", { reason: "need_decision", message: "help" });
		assert.equal(await childHarness.effectiveError(result, ctx, "contact_supervisor"), true);
	} finally {
		if (priorDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = priorDepth;
		if (priorIpc === undefined) delete process.env.PI_SUBAGENT_IPC_DIR;
		else process.env.PI_SUBAGENT_IPC_DIR = priorIpc;
	}
});

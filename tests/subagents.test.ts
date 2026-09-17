import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Agent, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import extension from "../extensions/subagents/index.ts";
import { discoverAgents } from "../extensions/subagents/agents.ts";

const model = {
	provider: "test-provider",
	id: "cheap",
	name: "Cheap",
	reasoning: true,
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};
const expensiveModel = { ...model, id: "expensive", name: "Expensive", cost: { ...model.cost, input: 100 } };

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

function makeContext(
	cwd: string,
	overrides: {
		trusted?: boolean;
		scopedModels?: Array<{ model: typeof model; thinkingLevel?: string }>;
		parentSessionFile?: string;
		hasUI?: boolean;
	} = {},
): any {
	const available = [model, expensiveModel];
	return {
		cwd,
		model,
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

	const fakePi = path.join(binDir, "pi");
	writeFileSync(
		fakePi,
		`#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (process.env.FAKE_PI_CAPTURE) appendFileSync(process.env.FAKE_PI_CAPTURE, JSON.stringify(args) + "\\n");
if (process.env.FAKE_PI_CWD_CAPTURE) appendFileSync(process.env.FAKE_PI_CWD_CAPTURE, process.cwd() + "\\n");
const sessionDirIndex = args.indexOf("--session-dir");
if (sessionDirIndex !== -1) {
  const sessionDir = args[sessionDirIndex + 1];
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, "fake-" + process.pid + ".jsonl"), JSON.stringify({ type: "session", version: 3, id: "fake" }) + "\\n");
}
if (process.env.FAKE_PI_MODE === "sigkill") process.kill(process.pid, "SIGKILL");
if (process.env.FAKE_PI_MODE === "wait") setInterval(() => {}, 1000);
let content;
if (process.env.FAKE_PI_MODE === "multi-text") {
  content = [{ type: "text", text: "first" }, { type: "text", text: "second" }];
} else {
  content = [{ type: "text", text: process.env.FAKE_PI_TEXT ?? "ok" }];
}
const events = process.env.FAKE_PI_MODE === "empty-final"
  ? [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stale" }], stopReason: "toolUse" } },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "end" } },
    ]
  : [{ type: "message_end", message: { role: "assistant", content, stopReason: "end" } }];
const bytes = Buffer.from(events.map((event) => JSON.stringify(event)).join("\\n") + "\\n", "utf8");
if (process.env.FAKE_PI_MODE === "split-utf8") {
  const emoji = Buffer.from("🙂", "utf8");
  const start = bytes.indexOf(emoji);
  process.stdout.write(bytes.subarray(0, start + 2));
  setTimeout(() => process.stdout.write(bytes.subarray(start + 2)), 20);
} else {
  process.stdout.write(bytes);
}
`,
	);
	chmodSync(fakePi, 0o755);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PATH = `${binDir}:${originalPath ?? ""}`;
	process.argv[1] = "/$bunfs/root/pi";
	delete process.env.PI_SUBAGENT_DEPTH;
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
		["PI_SUBAGENT_IPC_DIR", originalSubagentIpc],
		["PI_SUBAGENT_AGENT", originalSubagentAgent],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const key of ["FAKE_PI_MODE", "FAKE_PI_CAPTURE", "FAKE_PI_TEXT", "FAKE_PI_CWD_CAPTURE"]) delete process.env[key];
	rmSync(root, { recursive: true, force: true });
});

test("bundled recon has shell discovery without mutation tools", () => {
	const packageRoot = path.resolve(import.meta.dirname, "..");
	const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = packageRoot;
		const recon = discoverAgents(packageRoot, "user").agents.find((agent) => agent.name === "recon");
		assert.ok(recon);
		assert.deepEqual(recon.tools, ["read", "grep", "find", "ls", "bash"]);
		assert.ok(recon.aliases.includes("scout"));
		assert.equal(recon.tools.includes("edit"), false);
		assert.equal(recon.tools.includes("write"), false);
	} finally {
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	}
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
	assert.deepEqual(discovery.agents[0].tools, []);

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
	assert.deepEqual(discovery.agents.map((agent) => agent.name), ["valid"]);
});

test("scoped model thinking pins are forwarded to the child", async () => {
	const capture = path.join(root, "thinking-capture.jsonl");
	setFakeMode("normal", capture);
	const ctx = makeContext(root, { scopedModels: [{ model, thinkingLevel: "high" }] });
	await harness.refresh(ctx);
	await harness.execute({ agent: "general-purpose", task: "think", model: "test-provider/cheap" }, ctx);
	assert.equal(optionValue(captureArgs(capture)[0], "--thinking"), "high");
});

test("agent frontmatter cannot select a model outside configured scope", async () => {
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

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/subagents/index.ts";
import type { AgentConfig } from "../extensions/subagents/agents.ts";
import { writeFakePi } from "./fake-pi.ts";
import {
	encodeNestedRuntime,
	intersectModelCeiling,
	type NestedRuntimeV1,
	parseNestedRuntime,
	OWNER_PID_ENV_VAR,
	resolveAllowedAgents,
	RUNTIME_ENV_VAR,
	withinToolCeiling,
} from "../extensions/subagents/nested-runtime.ts";
import {
	DEFAULT_MAX_NESTED_CONCURRENCY,
	DEFAULT_MAX_NESTED_SPAWNS,
	MAX_NESTED_CONCURRENCY,
	MAX_NESTED_SPAWNS,
	parseBoundedInt,
	readSubagentSettings,
} from "../extensions/subagents/settings.ts";

const roots: string[] = [];
function tempRoot(): string {
	const root = mkdtempSync(path.join(tmpdir(), "nested-subagents-"));
	roots.push(root);
	return root;
}

type TestHandler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
type TestContext = {
	cwd: string;
	model: {
		provider: string;
		id: string;
		name: string;
		reasoning: boolean;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	};
	thinkingLevel: string;
	scopedModels: [];
	modelRegistry: {
		getAvailable: () => TestContext["model"][];
		find: () => TestContext["model"];
	};
	sessionManager: { getSessionFile: () => undefined };
	hasUI: boolean;
	isProjectTrusted: () => boolean;
	ui: {
		notify: () => void;
		input: () => Promise<undefined>;
		confirm: () => Promise<boolean>;
	};
};

type CapturedEnvironment = {
	depth: string | null;
	runtime: string | null;
	ipc: string | null;
	owner: string | null;
	agent: string | null;
	pid: number;
	pgrp: number | null;
};

class NestedHarness {
	readonly handlers = new Map<string, TestHandler[]>();
	readonly tools = new Map<string, unknown>();

	constructor() {
		const pi = {
			registerTool: (definition: { name: string }) => this.tools.set(definition.name, definition),
			unregisterTool: (name: string) => this.tools.delete(name),
			on: (event: string, handler: TestHandler) => {
				const handlers = this.handlers.get(event) ?? [];
				handlers.push(handler);
				this.handlers.set(event, handlers);
			},
		};
		extension(pi as unknown as ExtensionAPI);
	}

	async register(ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.get("session_start") ?? []) await handler({}, ctx);
	}

	async refresh(ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.get("model_select") ?? []) await handler({}, ctx);
	}

	async execute(params: Record<string, unknown>, ctx: ExtensionContext): Promise<unknown> {
		const definition = this.tools.get("subagent");
		assert.ok(definition && typeof definition === "object", "subagent tool should be registered");
		const execute = (definition as { execute?: unknown }).execute;
		assert.equal(typeof execute, "function", "subagent tool should be executable");
		return (execute as (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: undefined,
			ctx: ExtensionContext,
		) => Promise<unknown>)("test-call", params, new AbortController().signal, undefined, ctx);
	}
}

let root: string;
let agentDir: string;
let binDir: string;
let harness: NestedHarness;
let context: ExtensionContext;
const originalArgv1 = process.argv[1];
const originalPath = process.env.PATH;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalDepth = process.env.PI_SUBAGENT_DEPTH;
const originalRuntime = process.env[RUNTIME_ENV_VAR];
const originalIpc = process.env.PI_SUBAGENT_IPC_DIR;
const originalOwner = process.env[OWNER_PID_ENV_VAR];
const originalAgent = process.env.PI_SUBAGENT_AGENT;

function makeContext(): ExtensionContext {
	const model = {
		provider: "test-provider",
		id: "cheap",
		name: "Cheap",
		reasoning: true,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	};
	const value: TestContext = {
		cwd: root,
		model,
		thinkingLevel: "low",
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => [model],
			find: () => model,
		},
		sessionManager: { getSessionFile: () => undefined },
		hasUI: false,
		isProjectTrusted: () => false,
		ui: { notify: () => {}, input: async () => undefined, confirm: async () => true },
	};
	return value as unknown as ExtensionContext;
}

function writeAgentFile(
	name: string,
	options: { allowNestedSubagents?: boolean; allowedSubagents?: string; tools?: string } = {},
): string {
	const fields = [
		`name: ${name}`,
		`description: ${name} test agent`,
		options.tools === undefined ? undefined : `tools: ${options.tools}`,
		options.allowNestedSubagents ? "allowNestedSubagents: true" : undefined,
		options.allowedSubagents === undefined ? undefined : `allowedSubagents: ${options.allowedSubagents}`,
	].filter((field): field is string => field !== undefined);
	const target = path.join(agentDir, "agents", `${name}.md`);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, `---\n${fields.join("\n")}\n---\nYou are a test agent.\n`);
	return target;
}

function writeCoordinatorFixtures(): void {
	writeAgentFile("reviewer", {
		allowNestedSubagents: true,
		allowedSubagents: "recon",
		tools: "read,grep,find,ls,bash",
	});
	writeAgentFile("recon", { tools: "read,grep,find,ls,bash" });
}

function writeUserSettings(subagents: Record<string, unknown>): void {
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents }));
}

function clearUserSettings(): void {
	rmSync(path.join(agentDir, "settings.json"), { force: true });
}

function setFakeMode(mode: string, captureFile: string): void {
	process.env.FAKE_PI_MODE = mode;
	process.env.FAKE_PI_CAPTURE = captureFile;
	process.env.FAKE_PI_TEXT = "ok";
}

function capturedArgs(file: string): string[][] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as string[]);
}

function capturedEnvironment(file: string): CapturedEnvironment[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as CapturedEnvironment);
}

function optionValue(args: string[], option: string): string | undefined {
	const index = args.indexOf(option);
	return index === -1 ? undefined : args[index + 1];
}

function resultStderr(result: unknown): string {
	if (typeof result !== "object" || result === null) return "";
	const details = (result as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return "";
	const results = (details as { results?: unknown }).results;
	if (!Array.isArray(results) || results.length === 0) return "";
	const stderr = (results[0] as { stderr?: unknown }).stderr;
	return typeof stderr === "string" ? stderr : "";
}

async function runSubagent(params: Record<string, unknown>): Promise<unknown> {
	await harness.refresh(context);
	return harness.execute(params, context);
}

before(async () => {
	root = tempRoot();
	agentDir = path.join(root, "agent-home");
	binDir = path.join(root, "bin");
	mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeAgentFile("general-purpose");
	writeFakePi(binDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PATH = `${binDir}:${originalPath ?? ""}`;
	process.argv[1] = "/$bunfs/root/pi";
	delete process.env.PI_SUBAGENT_DEPTH;
	delete process.env[RUNTIME_ENV_VAR];
	delete process.env.PI_SUBAGENT_IPC_DIR;
	delete process.env[OWNER_PID_ENV_VAR];
	delete process.env.PI_SUBAGENT_AGENT;
	harness = new NestedHarness();
	context = makeContext();
	await harness.register(context);
});

after(async () => {
	process.argv[1] = originalArgv1;
	process.env.PATH = originalPath;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const [key, value] of [
		["PI_SUBAGENT_DEPTH", originalDepth],
		[RUNTIME_ENV_VAR, originalRuntime],
		["PI_SUBAGENT_IPC_DIR", originalIpc],
		[OWNER_PID_ENV_VAR, originalOwner],
		["PI_SUBAGENT_AGENT", originalAgent],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const key of [
		"FAKE_PI_MODE",
		"FAKE_PI_CAPTURE",
		"FAKE_PI_TEXT",
		"FAKE_PI_ENV_CAPTURE",
	])
		delete process.env[key];
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("parseBoundedInt accepts only integers inside the range", () => {
	assert.equal(parseBoundedInt(0, 0, 16), 0);
	assert.equal(parseBoundedInt(16, 0, 16), 16);
	assert.equal(parseBoundedInt(17, 0, 16), undefined);
	assert.equal(parseBoundedInt(-1, 0, 16), undefined);
	assert.equal(parseBoundedInt(1.5, 0, 16), undefined);
	assert.equal(parseBoundedInt("4", 0, 16), undefined);
	// "unbounded" is a fan-out concept and must not leak into a hard process cap.
	assert.equal(parseBoundedInt("unbounded", 0, 16), undefined);
	assert.equal(parseBoundedInt(0, 1, 8), undefined);
});

test("nested limits default when unset and when malformed", () => {
	const root = tempRoot();
	const agentDir = path.join(root, "agent-home");
	mkdirSync(agentDir, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ subagents: { maxNestedSpawns: "lots" } }),
		);
		const unset = readSubagentSettings(root, undefined);
		assert.equal(unset.maxNestedSpawns, DEFAULT_MAX_NESTED_SPAWNS);
		assert.equal(unset.maxNestedConcurrency, DEFAULT_MAX_NESTED_CONCURRENCY);

		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ subagents: { maxNestedSpawns: "lots", maxNestedConcurrency: 99 } }),
		);
		const malformed = readSubagentSettings(root, undefined);
		assert.equal(malformed.maxNestedSpawns, DEFAULT_MAX_NESTED_SPAWNS);
		assert.equal(malformed.maxNestedConcurrency, DEFAULT_MAX_NESTED_CONCURRENCY);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("a trusted project may lower the nested limits but never raise them", () => {
	const root = tempRoot();
	const agentDir = path.join(root, "agent-home");
	const project = path.join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(path.join(project, ".pi"), { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { maxNestedSpawns: 6 } }));
		const projectFile = path.join(project, ".pi", "settings.json");
		const trusted = { file: projectFile, root: project };

		writeFileSync(projectFile, JSON.stringify({ subagents: { maxNestedSpawns: 12 } }));
		assert.equal(readSubagentSettings(project, trusted).maxNestedSpawns, 6, "a project must not raise the cap");

		writeFileSync(projectFile, JSON.stringify({ subagents: { maxNestedSpawns: 1 } }));
		assert.equal(readSubagentSettings(project, trusted).maxNestedSpawns, 1, "a project may lower the cap");

		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { maxNestedSpawns: 0 } }));
		writeFileSync(projectFile, JSON.stringify({ subagents: { maxNestedSpawns: 4 } }));
		assert.equal(
			readSubagentSettings(project, trusted).maxNestedSpawns,
			0,
			"0 is a kill switch, not a typo",
		);

		// The spec requires both limits, and the two use different parsers and ranges.
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { maxNestedConcurrency: 0 } }));
		assert.equal(
			readSubagentSettings(root, undefined).maxNestedConcurrency,
			DEFAULT_MAX_NESTED_CONCURRENCY,
			"0 is out of range for concurrency",
		);
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { maxNestedConcurrency: 4 } }));
		writeFileSync(projectFile, JSON.stringify({ subagents: { maxNestedConcurrency: 8 } }));
		assert.equal(readSubagentSettings(project, trusted).maxNestedConcurrency, 4, "a project must not raise it either");
		writeFileSync(projectFile, JSON.stringify({ subagents: { maxNestedConcurrency: 2 } }));
		assert.equal(readSubagentSettings(project, trusted).maxNestedConcurrency, 2);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("envelope round-trips and rejects every malformed shape", () => {
	const runtime: NestedRuntimeV1 = {
		version: 1,
		depth: 1,
		agent: "reviewer",
		allowedAgents: ["recon"],
		toolCeiling: ["read", "grep"],
		modelCeiling: null,
		budget: { maxSpawns: 4, maxConcurrency: 2 },
	};
	assert.deepEqual(parseNestedRuntime(encodeNestedRuntime(runtime)), runtime);

	const bad: Array<[string, unknown]> = [
		["wrong version", { ...runtime, version: 2 }],
		["wrong depth", { ...runtime, depth: 2 }],
		["empty agent", { ...runtime, agent: "" }],
		["allowedAgents not an array", { ...runtime, allowedAgents: "recon" }],
		["allowedAgents holds a non-string", { ...runtime, allowedAgents: ["recon", 7] }],
		["allowedAgents holds an empty string", { ...runtime, allowedAgents: [""] }],
		["toolCeiling neither array nor null", { ...runtime, toolCeiling: "read" }],
		["modelCeiling neither array nor null", { ...runtime, modelCeiling: "gpt-5" }],
		["modelCeiling holds a non-string", { ...runtime, modelCeiling: [7] }],
		["budget missing", { ...runtime, budget: undefined }],
		["maxSpawns out of range", { ...runtime, budget: { maxSpawns: 99, maxConcurrency: 2 } }],
		["maxConcurrency zero", { ...runtime, budget: { maxSpawns: 4, maxConcurrency: 0 } }],
		["maxSpawns fractional", { ...runtime, budget: { maxSpawns: 1.5, maxConcurrency: 2 } }],
	];
	for (const [label, value] of bad) {
		assert.equal(parseNestedRuntime(JSON.stringify(value)), undefined, label);
	}

	assert.equal(parseNestedRuntime(undefined), undefined);
	assert.equal(parseNestedRuntime(""), undefined);
	assert.equal(parseNestedRuntime("not json"), undefined);
	assert.equal(parseNestedRuntime("null"), undefined);
	assert.equal(parseNestedRuntime("[]"), undefined);
});

test("an empty allowedAgents array parses but grants nothing", () => {
	// Parsing and authority are separate concerns: a well-formed envelope with no delegates is
	// valid data. Registration is what must refuse it, and Task 2's gate test proves that.
	const runtime: NestedRuntimeV1 = {
		version: 1,
		depth: 1,
		agent: "reviewer",
		allowedAgents: [],
		toolCeiling: null,
		modelCeiling: null,
		budget: { maxSpawns: 4, maxConcurrency: 2 },
	};
	assert.deepEqual(parseNestedRuntime(encodeNestedRuntime(runtime))?.allowedAgents, []);
});

test("nested runtime and settings share budget bounds", () => {
	const root = tempRoot();
	const agentDir = path.join(root, "agent-home");
	mkdirSync(agentDir, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const runtime: NestedRuntimeV1 = {
		version: 1,
		depth: 1,
		agent: "reviewer",
		allowedAgents: ["recon"],
		toolCeiling: null,
		modelCeiling: null,
		budget: { maxSpawns: MAX_NESTED_SPAWNS, maxConcurrency: MAX_NESTED_CONCURRENCY },
	};
	try {
		assert.deepEqual(parseNestedRuntime(encodeNestedRuntime(runtime))?.budget, runtime.budget);
		assert.equal(
			parseNestedRuntime(
				encodeNestedRuntime({
					...runtime,
					budget: { maxSpawns: MAX_NESTED_SPAWNS + 1, maxConcurrency: MAX_NESTED_CONCURRENCY },
				}),
			),
			undefined,
			"runtime rejects a spawn count above the settings bound",
		);
		assert.equal(
			parseNestedRuntime(
				encodeNestedRuntime({
					...runtime,
					budget: { maxSpawns: MAX_NESTED_SPAWNS, maxConcurrency: MAX_NESTED_CONCURRENCY + 1 },
				}),
			),
			undefined,
			"runtime rejects concurrency above the settings bound",
		);

		const settingsFile = path.join(agentDir, "settings.json");
		writeFileSync(
			settingsFile,
			JSON.stringify({
				subagents: { maxNestedSpawns: MAX_NESTED_SPAWNS, maxNestedConcurrency: MAX_NESTED_CONCURRENCY },
			}),
		);
		const atLimits = readSubagentSettings(root, undefined);
		assert.equal(atLimits.maxNestedSpawns, MAX_NESTED_SPAWNS);
		assert.equal(atLimits.maxNestedConcurrency, MAX_NESTED_CONCURRENCY);

		writeFileSync(
			settingsFile,
			JSON.stringify({
				subagents: { maxNestedSpawns: MAX_NESTED_SPAWNS + 1, maxNestedConcurrency: MAX_NESTED_CONCURRENCY },
			}),
		);
		const aboveSpawns = readSubagentSettings(root, undefined);
		assert.equal(aboveSpawns.maxNestedSpawns, DEFAULT_MAX_NESTED_SPAWNS);
		assert.equal(aboveSpawns.maxNestedConcurrency, MAX_NESTED_CONCURRENCY);

		writeFileSync(
			settingsFile,
			JSON.stringify({
				subagents: { maxNestedSpawns: MAX_NESTED_SPAWNS, maxNestedConcurrency: MAX_NESTED_CONCURRENCY + 1 },
			}),
		);
		const aboveConcurrency = readSubagentSettings(root, undefined);
		assert.equal(aboveConcurrency.maxNestedSpawns, MAX_NESTED_SPAWNS);
		assert.equal(aboveConcurrency.maxNestedConcurrency, DEFAULT_MAX_NESTED_CONCURRENCY);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

type GateHandler = (...args: unknown[]) => unknown;
type Extension = Parameters<typeof extension>[0];

/** Minimal stand-in for Pi's extension API: records what the extension registers. */
function registerAt(depth: string | undefined, envelope: string | undefined): Set<string> {
	const names = new Set<string>();
	const handlers = new Map<string, GateHandler[]>();
	const pi = {
		on: (event: string, handler: GateHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool: (tool: { name: string }) => {
			names.add(tool.name);
		},
		unregisterTool: (name: string) => {
			names.delete(name);
		},
	};
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	const previousRuntime = process.env[RUNTIME_ENV_VAR];
	// Task 8 makes extension(pi) start an owner guard that can call process.exit(0). An inherited
	// PI_SUBAGENT_OWNER_PID naming a dead process would end this test run at exit code 0, which
	// reads as a pass. Delete it here and restore it in the finally alongside the other two.
	const previousOwner = process.env[OWNER_PID_ENV_VAR];
	delete process.env[OWNER_PID_ENV_VAR];
	// registerSubagentTool calls discoverAgents, whose user directory is getAgentDir()/agents.
	// Without this redirect the test reads the developer's real agent directory and its outcome
	// depends on whatever they happen to have installed.
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const sandbox = tempRoot();
	mkdirSync(path.join(sandbox, "agents"), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = sandbox;
	if (depth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
	else process.env.PI_SUBAGENT_DEPTH = depth;
	if (envelope === undefined) delete process.env[RUNTIME_ENV_VAR];
	else process.env[RUNTIME_ENV_VAR] = envelope;
	try {
		extension(pi as unknown as Extension);
		for (const handler of handlers.get("session_start") ?? []) handler({}, makeGateContext());
	} finally {
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		if (previousRuntime === undefined) delete process.env[RUNTIME_ENV_VAR];
		else process.env[RUNTIME_ENV_VAR] = previousRuntime;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousOwner === undefined) delete process.env[OWNER_PID_ENV_VAR];
		else process.env[OWNER_PID_ENV_VAR] = previousOwner;
	}
	return names;
}

function makeGateContext(): unknown {
	const root = tempRoot();
	const available = [
		{ provider: "p", id: "m", name: "M", reasoning: true, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
	];
	return {
		cwd: root,
		model: available[0],
		thinkingLevel: "low",
		scopedModels: [],
		modelRegistry: { getAvailable: () => available, find: () => available[0] },
		sessionManager: { getSessionFile: () => undefined },
		hasUI: false,
		isProjectTrusted: () => false,
		ui: { notify: () => {}, input: async () => undefined, confirm: async () => true },
	};
}

const gateEnvelope = encodeNestedRuntime({
	version: 1,
	depth: 1,
	agent: "reviewer",
	allowedAgents: ["recon"],
	toolCeiling: ["read"],
	modelCeiling: null,
	budget: { maxSpawns: 4, maxConcurrency: 2 },
});

test("registration gate: the five depth and envelope states", () => {
	assert.deepEqual([...registerAt(undefined, undefined)], ["subagent"], "root registers subagent");
	assert.deepEqual(
		[...registerAt("1", gateEnvelope)].sort(),
		["contact_supervisor", "subagent"],
		"valid envelope at depth 1",
	);
	assert.deepEqual([...registerAt("1", undefined)], ["contact_supervisor"], "absent envelope at depth 1");
	assert.deepEqual([...registerAt("1", "{not json")], ["contact_supervisor"], "malformed envelope at depth 1");
	assert.deepEqual([...registerAt("2", gateEnvelope)], ["contact_supervisor"], "depth 2 ignores the envelope");
});

test("depth 2 refuses the very envelope depth 1 accepts", () => {
	// Differential: same envelope, only the depth differs. Without this pairing the refusal could
	// come from a malformed envelope and the test would still pass with the depth check removed.
	assert.ok(registerAt("1", gateEnvelope).has("subagent"));
	assert.ok(!registerAt("2", gateEnvelope).has("subagent"));
});

test("an envelope with no allowed agents registers no subagent tool", () => {
	const empty = encodeNestedRuntime({
		version: 1,
		depth: 1,
		agent: "reviewer",
		allowedAgents: [],
		toolCeiling: null,
		modelCeiling: null,
		budget: { maxSpawns: 4, maxConcurrency: 2 },
	});
	assert.deepEqual([...registerAt("1", empty)], ["contact_supervisor"]);
});

test("tool ceiling: a child may never exceed its coordinator", () => {
	// Row 1: explicit coordinator, explicit subset child.
	assert.equal(withinToolCeiling(["read", "grep", "bash"], ["read", "grep"]), true);
	assert.equal(withinToolCeiling(["read", "grep"], ["read", "grep"]), true);
	// Row 2: explicit coordinator, child reaching beyond it.
	assert.equal(withinToolCeiling(["read", "grep"], ["read", "write"]), false);
	// Row 3: omitted child tools mean Pi's full default set, which is broader than any allowlist.
	assert.equal(withinToolCeiling(["read", "grep"], undefined), false);
	// Row 4: an unrestricted coordinator may coordinate anything; it already held everything.
	assert.equal(withinToolCeiling(undefined, undefined), true);
	assert.equal(withinToolCeiling(undefined, ["read", "write", "bash"]), true);
	// The internal tools are injected by the extension and are not part of the comparison.
	assert.equal(withinToolCeiling(["read"], ["read", "contact_supervisor"]), true);
	assert.equal(withinToolCeiling(["read"], ["read", "subagent"]), true);
	// An empty child allowlist is a subset of everything.
	assert.equal(withinToolCeiling(["read"], []), true);
});

function agent(over: Partial<AgentConfig> & { name: string }): AgentConfig {
	return {
		aliases: [],
		description: "d",
		inheritSkills: false,
		inheritProjectContext: true,
		suggest: true,
		allowNestedSubagents: false,
		allowedSubagents: [],
		systemPrompt: "p",
		source: "builtin",
		filePath: `/fake/${over.name}.md`,
		...over,
	};
}

test("allowlist resolution keeps survivors and reports every drop", () => {
	const reviewer = agent({
		name: "reviewer",
		tools: ["read", "grep"],
		allowNestedSubagents: true,
		allowedSubagents: ["recon", "reviewer", "ghost", "twin", "general-purpose", "writer"],
	});
	const agents = [
		reviewer,
		agent({ name: "recon", tools: ["read", "grep"] }),
		agent({ name: "general-purpose" }), // no tools: the full default set
		agent({ name: "writer", tools: ["read", "write"] }), // reaches beyond the ceiling
		agent({ name: "twin-a", aliases: ["twin"], tools: ["read"] }),
		agent({ name: "twin-b", aliases: ["twin"], tools: ["read"] }),
	];
	const { allowed, dropped } = resolveAllowedAgents(reviewer, agents);
	assert.deepEqual(allowed, ["recon"]);
	const reasons = new Map(dropped.map((d) => [d.name, d.reason]));
	assert.match(reasons.get("reviewer") ?? "", /itself/i);
	assert.match(reasons.get("ghost") ?? "", /not found/i);
	assert.match(reasons.get("twin") ?? "", /ambiguous|not found/i);
	assert.match(reasons.get("general-purpose") ?? "", /tool/i);
	assert.match(reasons.get("writer") ?? "", /tool/i);
});

test("a coordinator that allow-lists only itself resolves to nothing", () => {
	// A lazy coordinator handing its whole task to another instance of itself passes a tool-ceiling
	// check perfectly: the two tool sets are identical by construction. The allowlist is the only
	// mechanism that can catch it.
	const reviewer = agent({ name: "reviewer", tools: ["read"], allowNestedSubagents: true, allowedSubagents: ["reviewer"] });
	const { allowed, dropped } = resolveAllowedAgents(reviewer, [reviewer]);
	assert.deepEqual(allowed, []);
	assert.equal(dropped.length, 1);
});

test("self-reference is dropped by identity, not by spelling", () => {
	const reviewer = agent({
		name: "reviewer",
		aliases: ["review", "auditor"],
		tools: ["read"],
		allowNestedSubagents: true,
		allowedSubagents: ["auditor"],
	});
	assert.deepEqual(resolveAllowedAgents(reviewer, [reviewer]).allowed, []);
});

test("self-reference is dropped when names match across different files", () => {
	const coordinator = agent({
		name: "reviewer",
		filePath: "/a/reviewer.md",
		tools: ["read"],
		allowNestedSubagents: true,
		allowedSubagents: ["reviewer"],
	});
	const sameName = agent({ name: "reviewer", filePath: "/other/reviewer.md", tools: ["read"] });
	assert.deepEqual(resolveAllowedAgents(coordinator, [sameName]).allowed, []);
});

test("self-reference is dropped when file identity matches across different names", () => {
	const coordinator = agent({
		name: "reviewer",
		filePath: "/a/reviewer.md",
		tools: ["read"],
		allowNestedSubagents: true,
		allowedSubagents: ["clone"],
	});
	const clone = agent({ name: "clone", filePath: "/a/reviewer.md", tools: ["read"] });
	assert.deepEqual(resolveAllowedAgents(coordinator, [clone]).allowed, []);
});

test("resolution matches names and aliases case-insensitively", () => {
	const boss = agent({
		name: "boss",
		tools: ["read"],
		allowNestedSubagents: true,
		allowedSubagents: ["RECON", "SCOUT"],
	});
	const recon = agent({ name: "recon", tools: ["read"] });
	const scout = agent({ name: "other", aliases: ["scout"], tools: ["read"] });
	assert.deepEqual(resolveAllowedAgents(boss, [boss, recon, scout]).allowed, ["recon", "other"]);
});

test("resolution canonicalises an alias to the agent's real name", () => {
	const boss = agent({ name: "boss", tools: ["read"], allowNestedSubagents: true, allowedSubagents: ["scout"] });
	const recon = agent({ name: "recon", aliases: ["scout"], tools: ["read"] });
	assert.deepEqual(resolveAllowedAgents(boss, [boss, recon]).allowed, ["recon"]);
});

test("duplicate names resolve once", () => {
	const boss = agent({ name: "boss", tools: ["read"], allowNestedSubagents: true, allowedSubagents: ["recon", "recon"] });
	const recon = agent({ name: "recon", tools: ["read"] });
	assert.deepEqual(resolveAllowedAgents(boss, [boss, recon]).allowed, ["recon"]);
});

test("model ceiling intersects, preserves order, and distinguishes null from empty", () => {
	const cheap = { provider: "p", id: "cheap", name: "C", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
	const dear = { provider: "p", id: "dear", name: "D", cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } };
	const choices = [cheap, dear];
	// null means the root was unscoped: everything local stays selectable.
	assert.deepEqual(intersectModelCeiling(choices, null), choices);
	assert.deepEqual(intersectModelCeiling(choices, ["p/cheap"]), [cheap]);
	// Matching is case-insensitive and output order remains the local choice order, not ceiling order.
	assert.deepEqual(intersectModelCeiling(choices, ["P/DEAR", "P/CHEAP"]), choices);
	// An empty ceiling means nothing is selectable. It must never be read as "unrestricted".
	assert.deepEqual(intersectModelCeiling(choices, []), []);
	// A ceiling naming something absent locally yields nothing rather than falling back.
	assert.deepEqual(intersectModelCeiling(choices, ["p/absent"]), []);
});

test("an ordinary depth-1 child gets no envelope and no owner pid", async () => {
	const capture = path.join(root, "ordinary-env.jsonl");
	const argvCapture = path.join(root, "ordinary-argv.jsonl");
	const previousRuntime = process.env[RUNTIME_ENV_VAR];
	process.env[RUNTIME_ENV_VAR] = "ambient-stale-envelope";
	process.env.FAKE_PI_ENV_CAPTURE = capture;
	setFakeMode("normal", argvCapture);
	try {
		await runSubagent({ agent: "general-purpose", task: "anything" });
		const seen = capturedEnvironment(capture)[0];
		assert.equal(seen.depth, "1");
		assert.equal(seen.runtime, "", "the envelope must be explicitly cleared, not merely absent");
		assert.equal(seen.owner, null, "an ordinary child is not owned and survives a root crash today");
		assert.equal(seen.agent, "general-purpose");
		const args = capturedArgs(argvCapture)[0];
		assert.equal(optionValue(args, "--tools"), undefined);
		assert.equal(optionValue(args, "--model"), "test-provider/cheap");
		assert.equal(optionValue(args, "--thinking"), "low");
	} finally {
		delete process.env.FAKE_PI_ENV_CAPTURE;
		if (previousRuntime === undefined) delete process.env[RUNTIME_ENV_VAR];
		else process.env[RUNTIME_ENV_VAR] = previousRuntime;
	}
});

test("a coordinator receives an envelope naming exactly its resolved delegates", async () => {
	writeCoordinatorFixtures();
	const capture = path.join(root, "coordinator-env.jsonl");
	const argvCapture = path.join(root, "coordinator-argv.jsonl");
	process.env.FAKE_PI_ENV_CAPTURE = capture;
	setFakeMode("normal", argvCapture);
	try {
		await runSubagent({ agent: "reviewer", task: "review this" });
		const seen = capturedEnvironment(capture)[0];
		assert.equal(seen.depth, "1");
		const runtime = parseNestedRuntime(seen.runtime || undefined);
		assert.ok(runtime, "the coordinator must receive a well-formed envelope");
		assert.equal(runtime.agent, "reviewer");
		assert.deepEqual(runtime.allowedAgents, ["recon"]);
		assert.equal(seen.owner, String(process.pid), "a coordinator is owned by the root");
		const args = capturedArgs(argvCapture)[0];
		assert.ok(args.includes("--tools"), "a coordinator must receive an explicit tool allowlist");
		assert.ok(optionValue(args, "--tools")?.split(",").includes("subagent"));
	} finally {
		delete process.env.FAKE_PI_ENV_CAPTURE;
	}
});

test("maxNestedSpawns: 0 emits no envelope at all", async () => {
	writeCoordinatorFixtures();
	writeUserSettings({ maxNestedSpawns: 0 });
	const capture = path.join(root, "kill-switch-env.jsonl");
	const argvCapture = path.join(root, "kill-switch-argv.jsonl");
	process.env.FAKE_PI_ENV_CAPTURE = capture;
	setFakeMode("normal", argvCapture);
	try {
		await runSubagent({ agent: "reviewer", task: "review this" });
		const seen = capturedEnvironment(capture)[0];
		assert.equal(seen.runtime, "");
		assert.equal(seen.owner, null, "with nesting off there is no coordinator subtree to own");
	} finally {
		clearUserSettings();
		delete process.env.FAKE_PI_ENV_CAPTURE;
	}
});

test("a coordinator whose allowlist resolves empty launches as an ordinary child", async () => {
	writeAgentFile("lonely", { allowNestedSubagents: true, allowedSubagents: "nobody", tools: "read" });
	const capture = path.join(root, "empty-allowlist-env.jsonl");
	const argvCapture = path.join(root, "empty-allowlist-argv.jsonl");
	process.env.FAKE_PI_ENV_CAPTURE = capture;
	setFakeMode("normal", argvCapture);
	try {
		const result = await runSubagent({ agent: "lonely", task: "go" });
		const seen = capturedEnvironment(capture)[0];
		assert.equal(seen.runtime, "", "nothing survived resolution, so nothing is granted");
		assert.match(resultStderr(result), /nobody/, "the drop must be reported, not swallowed");
		assert.equal(capturedEnvironment(capture).length, 1, "no second process may start");
	} finally {
		delete process.env.FAKE_PI_ENV_CAPTURE;
	}
});

test("a grandchild's environment carries no authority at all", async () => {
	writeCoordinatorFixtures();
	const capture = path.join(root, "grandchild-env.jsonl");
	const argvCapture = path.join(root, "grandchild-argv.jsonl");
	process.env.FAKE_PI_ENV_CAPTURE = capture;
	setFakeMode("delegate", argvCapture);
	try {
		await runSubagent({ agent: "reviewer", task: "verify" });
		const lines = capturedEnvironment(capture);
		const coordinator = lines.find((line) => line.agent === "reviewer");
		const grandchild = lines.find((line) => line.agent === "recon");
		assert.ok(coordinator && grandchild, "both levels must have launched");
		assert.equal(grandchild.depth, "2");
		assert.equal(grandchild.runtime, "", "an inherited envelope is how depth 2 would become depth 3");
		assert.equal(grandchild.ipc, "", "a grandchild has no channel to the operator");
		assert.notEqual(grandchild.owner, null);
		assert.notEqual(grandchild.owner, String(process.pid), "owned by its coordinator, not by the root");
	} finally {
		delete process.env.FAKE_PI_ENV_CAPTURE;
	}
});

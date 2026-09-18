import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import extension from "../extensions/subagents/index.ts";
import {
	encodeNestedRuntime,
	type NestedRuntimeV1,
	parseNestedRuntime,
	RUNTIME_ENV_VAR,
} from "../extensions/subagents/nested-runtime.ts";
import {
	DEFAULT_MAX_NESTED_CONCURRENCY,
	DEFAULT_MAX_NESTED_SPAWNS,
	parseBoundedInt,
	readSubagentSettings,
} from "../extensions/subagents/settings.ts";

const roots: string[] = [];
function tempRoot(): string {
	const root = mkdtempSync(path.join(tmpdir(), "nested-subagents-"));
	roots.push(root);
	return root;
}
after(() => {
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
	const previousOwner = process.env.PI_SUBAGENT_OWNER_PID;
	delete process.env.PI_SUBAGENT_OWNER_PID;
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
		if (previousOwner === undefined) delete process.env.PI_SUBAGENT_OWNER_PID;
		else process.env.PI_SUBAGENT_OWNER_PID = previousOwner;
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

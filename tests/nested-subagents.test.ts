import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/subagents/index.ts";
import { __resetNestedSpawnBudget } from "../extensions/subagents/dispatch.ts";
import type { AgentConfig } from "../extensions/subagents/agents.ts";
import { writeFakePi } from "./fake-pi.ts";
import {
	encodeNestedRuntime,
	intersectModelCeiling,
	nestedRegistrationAllowed,
	type NestedRuntimeV1,
	parseNestedRuntime,
	OWNER_PID_ENV_VAR,
	resolveAllowedAgents,
	RUNTIME_ENV_VAR,
	withinToolCeiling,
} from "../extensions/subagents/nested-runtime.ts";
import { makeNestedSubagentParams } from "../extensions/subagents/schema.ts";
import { coordinatorSpawnOptions, startOwnerGuard, terminateOwnedTree, windowsTreeKillCommand } from "../extensions/subagents/process-tree.ts";
import {
	DEFAULT_MAX_NESTED_CONCURRENCY,
	DEFAULT_MAX_NESTED_SPAWNS,
	MAX_NESTED_CONCURRENCY,
	MAX_NESTED_SPAWNS,
	parseBoundedInt,
	readSubagentSettings,
} from "../extensions/subagents/settings.ts";
import { isProcessAlive, retainedRuns } from "../extensions/subagents/runs.ts";

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
	scopedModels: Array<{ model: TestContext["model"]; thinkingLevel?: string }>;
	modelRegistry: {
		getAvailable: () => TestContext["model"][];
		find: (provider: string, id: string) => TestContext["model"] | undefined;
	};
	sessionManager: { getSessionFile: () => string | undefined };
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

const cheapModel = { provider: "p", id: "cheap", cost: { input: 1 } };
const dearModel = { provider: "p", id: "dear", cost: { input: 9 } };
function envelopeWith(budget: NestedRuntimeV1["budget"]): string {
	return encodeNestedRuntime({
		version: 1,
		depth: 1,
		agent: "reviewer",
		allowedAgents: ["recon"],
		toolCeiling: null,
		modelCeiling: null,
		budget,
	});
}

const nestedGuardRuntime = envelopeWith({ maxSpawns: 4, maxConcurrency: 2 });

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

	async execute(params: Record<string, unknown>, ctx: ExtensionContext, signal = new AbortController().signal): Promise<unknown> {
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
		) => Promise<unknown>)("test-call", params, signal, undefined, ctx);
	}
}

let root: string;
let agentDir: string;
let binDir: string;
let treeBinDir: string;
let treePiPath: string;
let treeWaitScript: string;
let treeIgnoreSigtermScript: string;
let treeGuardScript: string;
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

beforeEach(() => __resetNestedSpawnBudget());

function makeContext(cwd = root, scoped = false): ExtensionContext {
	const model = {
		provider: "test-provider",
		id: "cheap",
		name: "Cheap",
		reasoning: true,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	};
	const value: TestContext = {
		cwd,
		model,
		thinkingLevel: "low",
		scopedModels: scoped ? [{ model, thinkingLevel: "low" }] : [],
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
	options: { allowNestedSubagents?: boolean; allowedSubagents?: string; tools?: string; model?: string } = {},
	directory = path.join(agentDir, "agents"),
): string {
	const fields = [
		`name: ${name}`,
		`description: ${name} test agent`,
		options.tools === undefined ? undefined : `tools: ${options.tools}`,
		options.model === undefined ? undefined : `model: ${options.model}`,
		options.allowNestedSubagents ? "allowNestedSubagents: true" : undefined,
		options.allowedSubagents === undefined ? undefined : `allowedSubagents: ${options.allowedSubagents}`,
	].filter((field): field is string => field !== undefined);
	const target = path.join(directory, `${name}.md`);
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

function writeTreeFixture(): void {
	treeBinDir = path.join(root, "tree-bin");
	mkdirSync(treeBinDir, { recursive: true });
	treeWaitScript = path.join(root, "tree-wait-grandchild.mjs");
	writeFileSync(treeWaitScript, "setInterval(() => {}, 1000);\n");
	treeIgnoreSigtermScript = path.join(root, "tree-ignore-sigterm-grandchild.mjs");
	writeFileSync(
		treeIgnoreSigtermScript,
		`import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
if (process.env.TREE_GRANDCHILD_READY_FILE) writeFileSync(process.env.TREE_GRANDCHILD_READY_FILE, "ready");
setInterval(() => {}, 1000);
`,
	);
	const extensionUrl = pathToFileURL(
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/subagents/index.ts"),
	).href;
	treeGuardScript = path.join(root, "tree-guard-grandchild.mjs");
	writeFileSync(
		treeGuardScript,
		`import { writeFileSync } from "node:fs";
import extension from ${JSON.stringify(extensionUrl)};
const handlers = new Map();
const pi = { on(event, handler) { handlers.set(event, handler); } };
extension(pi);
const shutdownFile = process.env.TREE_GUARD_SHUTDOWN_FILE;
if (shutdownFile) {
  const shutdown = handlers.get("session_shutdown");
  if (typeof shutdown !== "function") throw new Error("session shutdown handler was not registered");
  shutdown({}, { hasUI: false });
  writeFileSync(shutdownFile, "disposed");
}
setInterval(() => {}, 1000);
`,
	);
	treePiPath = path.join(treeBinDir, "pi");
	writeFileSync(
		treePiPath,
		`#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const coordinatorPidFile = process.env.TREE_COORDINATOR_PID_FILE;
const grandchildPidFile = process.env.TREE_GRANDCHILD_PID_FILE;
const grandchildScript = process.env.TREE_GRANDCHILD_SCRIPT;
if (!coordinatorPidFile || !grandchildPidFile || !grandchildScript) throw new Error("tree fixture is missing its paths");
writeFileSync(coordinatorPidFile, String(process.pid));
const grandchild = spawn(process.execPath, [grandchildScript], {
  env: { ...process.env, PI_SUBAGENT_OWNER_PID: String(process.pid) },
  stdio: "ignore",
});
writeFileSync(grandchildPidFile, String(grandchild.pid));
setInterval(() => {}, 1000);
`,
	);
	chmodSync(treePiPath, 0o755);
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

function spawnCount(file: string): number {
	return existsSync(file) ? capturedArgs(file).length : 0;
}

async function waitForSpawnCount(file: string, expected: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (spawnCount(file) >= expected) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(spawnCount(file), expected, `expected ${expected} child spawn(s) in ${file}`);
}

function setConcurrencyProbe(captureFile: string, holdMs: number): void {
	process.env.FAKE_PI_CONCURRENCY_CAPTURE = captureFile;
	process.env.FAKE_PI_HOLD_MS = String(holdMs);
}

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

function capturedEnvironment(file: string): CapturedEnvironment[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as CapturedEnvironment);
}

/** The calling test process's own process-group id, for comparison. Linux only. */
function ownPgrp(): number {
	const stat = readFileSync("/proc/self/stat", "utf8");
	return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
}

const linuxOnly = { skip: process.platform !== "linux" ? "requires /proc" : false };

function optionValue(args: string[], option: string): string | undefined {
	const index = args.indexOf(option);
	return index === -1 ? undefined : args[index + 1];
}

function resultText(result: unknown): string {
	if (typeof result !== "object" || result === null) return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: unknown) => {
			if (typeof part !== "object" || part === null) return "";
			const text = (part as { type?: unknown; text?: unknown });
			return text.type === "text" && typeof text.text === "string" ? text.text : "";
		})
		.join("\n");
}

function runIdOf(result: unknown): string {
	if (typeof result !== "object" || result === null) throw new Error("subagent result is not an object");
	const details = (result as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) throw new Error("subagent result has no details");
	const results = (details as { results?: unknown }).results;
	if (!Array.isArray(results) || results.length === 0) throw new Error("subagent result has no child result");
	const runId = (results[0] as { runId?: unknown }).runId;
	if (typeof runId !== "string") throw new Error("subagent result has no run id");
	return runId;
}

function retainRunWithoutContract(agent: string): string {
	const id = "legacy-no-contract";
	const runDir = path.join(root, id);
	const sessionFile = path.join(runDir, "session.jsonl");
	mkdirSync(runDir, { recursive: true });
	writeFileSync(sessionFile, "{\"type\":\"session\"}\n");
	retainedRuns.set(id, {
		id,
		agent,
		agentSource: "user",
		agentFilePath: path.join(agentDir, "agents", `${agent}.md`),
		model: "test-provider/cheap",
		thinking: "low",
		tools: ["read"],
		inheritSkills: false,
		inheritProjectContext: true,
		systemPrompt: "You are a retained test agent.",
		cwd: root,
		runDir,
		sessionFile,
		resumable: true,
	});
	return id;
}

async function runSubagent(
	params: Record<string, unknown>,
	dispatchContext: ExtensionContext = context,
): Promise<unknown> {
	await harness.refresh(dispatchContext);
	return harness.execute(params, dispatchContext);
}

async function runSubagentWithSignal(params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
	await harness.refresh(context);
	return harness.execute(params, context, signal);
}

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) {
			assert.fail(`condition did not become true within ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function waitForFile(file: string): Promise<void> {
	await waitUntil(() => existsSync(file));
}

async function waitForPidFile(file: string): Promise<void> {
	await waitUntil(() => {
		if (!existsSync(file)) return false;
		try {
			const pid = Number(readFileSync(file, "utf8").trim());
			return Number.isInteger(pid) && pid > 0;
		} catch {
			return false;
		}
	});
}

function readPid(file: string): number {
	const pid = Number(readFileSync(file, "utf8").trim());
	assert.ok(Number.isInteger(pid) && pid > 0, `invalid pid in ${file}: ${JSON.stringify(String(pid))}`);
	return pid;
}

function moduleUrl(relativePath: string): string {
	return pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), relativePath)).href;
}

async function runCoordinatorWithGrandchild(
	pidFile: string,
	signal: AbortSignal,
	guarded = false,
	coordinatorPidFile = path.join(root, "tree-coordinator.pid"),
	guardShutdownFile?: string,
): Promise<unknown> {
	const previousPath = process.env.PATH;
	const previousCoordinatorPid = process.env.TREE_COORDINATOR_PID_FILE;
	const previousGrandchildPid = process.env.TREE_GRANDCHILD_PID_FILE;
	const previousGrandchildScript = process.env.TREE_GRANDCHILD_SCRIPT;
	const previousGuardShutdown = process.env.TREE_GUARD_SHUTDOWN_FILE;
	writeCoordinatorFixtures();
	process.env.PATH = `${treeBinDir}:${previousPath ?? ""}`;
	process.env.TREE_COORDINATOR_PID_FILE = coordinatorPidFile;
	process.env.TREE_GRANDCHILD_PID_FILE = pidFile;
	process.env.TREE_GRANDCHILD_SCRIPT = guarded ? treeGuardScript : treeWaitScript;
	if (guardShutdownFile === undefined) delete process.env.TREE_GUARD_SHUTDOWN_FILE;
	else process.env.TREE_GUARD_SHUTDOWN_FILE = guardShutdownFile;
	try {
		return await runSubagentWithSignal({ agent: "reviewer", task: "process tree" }, signal);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousCoordinatorPid === undefined) delete process.env.TREE_COORDINATOR_PID_FILE;
		else process.env.TREE_COORDINATOR_PID_FILE = previousCoordinatorPid;
		if (previousGrandchildPid === undefined) delete process.env.TREE_GRANDCHILD_PID_FILE;
		else process.env.TREE_GRANDCHILD_PID_FILE = previousGrandchildPid;
		if (previousGrandchildScript === undefined) delete process.env.TREE_GRANDCHILD_SCRIPT;
		else process.env.TREE_GRANDCHILD_SCRIPT = previousGrandchildScript;
		if (previousGuardShutdown === undefined) delete process.env.TREE_GUARD_SHUTDOWN_FILE;
		else process.env.TREE_GUARD_SHUTDOWN_FILE = previousGuardShutdown;
	}
}

function beginCoordinatorWithGrandchild(
	pidFile: string,
	guarded = false,
	coordinatorPidFile = path.join(root, "tree-coordinator.pid"),
	guardShutdownFile?: string,
): { controller: AbortController; running: Promise<unknown> } {
	const controller = new AbortController();
	return {
		controller,
		running: runCoordinatorWithGrandchild(pidFile, controller.signal, guarded, coordinatorPidFile, guardShutdownFile),
	};
}

async function startCoordinatorThenSigkillIt(pidFile: string): Promise<number> {
	const coordinatorPidFile = path.join(root, "abrupt-coordinator.pid");
	const { controller, running } = beginCoordinatorWithGrandchild(pidFile, true, coordinatorPidFile);
	let coordinatorPid: number | undefined;
	let grandchildPid: number | undefined;
	try {
		await waitForPidFile(coordinatorPidFile);
		await waitForPidFile(pidFile);
		coordinatorPid = readPid(coordinatorPidFile);
		grandchildPid = readPid(pidFile);
		assert.ok(isProcessAlive(coordinatorPid), "the coordinator must be alive before it is killed");
		assert.ok(isProcessAlive(grandchildPid), "the grandchild must be alive before its owner is killed");
		process.kill(coordinatorPid, "SIGKILL");
		await running;
		return coordinatorPid;
	} finally {
		if (coordinatorPid !== undefined && isProcessAlive(coordinatorPid)) process.kill(coordinatorPid, "SIGKILL");
		if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
		controller.abort();
		await running;
	}
}

async function executeNested(params: Record<string, unknown>, runtime = nestedGuardRuntime): Promise<unknown> {
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	const previousRuntime = process.env[RUNTIME_ENV_VAR];
	process.env.PI_SUBAGENT_DEPTH = "1";
	process.env[RUNTIME_ENV_VAR] = runtime;
	try {
		await harness.refresh(context);
		return await harness.execute(params, context);
	} finally {
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		if (previousRuntime === undefined) delete process.env[RUNTIME_ENV_VAR];
		else process.env[RUNTIME_ENV_VAR] = previousRuntime;
	}
}

before(async () => {
	root = tempRoot();
	agentDir = path.join(root, "agent-home");
	binDir = path.join(root, "bin");
	mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeAgentFile("general-purpose");
	writeFakePi(binDir);
	writeTreeFixture();
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

test("windows tree-kill targets the whole tree and forces it", () => {
	const { command, args } = windowsTreeKillCommand(4321);
	assert.equal(command, "taskkill.exe");
	assert.deepEqual(args, ["/PID", "4321", "/T", "/F"]);
});

test("coordinator spawn options detach only on POSIX", () => {
	const originalPlatform = process.platform;
	try {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		assert.deepEqual(coordinatorSpawnOptions(), {});
		Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
		assert.deepEqual(coordinatorSpawnOptions(), { detached: true });
	} finally {
		Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
	}
});

test("Windows termination invokes taskkill for a live coordinator", () => {
	const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
	const originalSpawnSync = childProcess.spawnSync;
	const originalPlatform = process.platform;
	const calls: Array<{ command: string; args: string[] }> = [];
	childProcess.spawnSync = ((command: string, args: string[]) => {
		calls.push({ command, args });
		return { status: 0, error: undefined } as never;
	}) as unknown as typeof childProcess.spawnSync;
	syncBuiltinESMExports();
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	try {
		terminateOwnedTree(
			{
				pid: 4321,
				exitCode: null,
				signalCode: null,
				kill: () => true,
				once: () => undefined,
			},
			1,
		);
	} finally {
		Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
		childProcess.spawnSync = originalSpawnSync;
		syncBuiltinESMExports();
	}
	assert.deepEqual(calls, [{ command: "taskkill.exe", args: ["/PID", "4321", "/T", "/F"] }]);
});

test("Windows termination falls back to SIGTERM when taskkill fails", () => {
	const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
	const originalSpawnSync = childProcess.spawnSync;
	const originalPlatform = process.platform;
	const results = [
		{ status: 1, error: undefined },
		{ status: null, error: new Error("taskkill missing") },
	] as const;
	for (const result of results) {
		const signals: NodeJS.Signals[] = [];
		const proc = {
			pid: 4321,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill: (signal?: NodeJS.Signals) => {
				if (signal) signals.push(signal);
				if (signal === "SIGTERM") proc.exitCode = 0;
				return true;
			},
			once: () => undefined,
		};
		childProcess.spawnSync = (() => result) as unknown as typeof childProcess.spawnSync;
		syncBuiltinESMExports();
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		try {
			terminateOwnedTree(proc, 1);
		} finally {
			Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			childProcess.spawnSync = originalSpawnSync;
			syncBuiltinESMExports();
		}
		assert.deepEqual(signals, ["SIGTERM"]);
	}
});

test("an exited coordinator is never signalled through its former group", () => {
	let processKillCalls = 0;
	const originalKill = process.kill;
	process.kill = (() => {
		processKillCalls++;
		return true;
	}) as typeof process.kill;
	try {
		terminateOwnedTree(
			{
				pid: 4321,
				exitCode: 0,
				signalCode: null,
				kill: () => true,
				once: () => undefined,
			},
			1,
		);
	} finally {
		process.kill = originalKill;
	}
	assert.equal(processKillCalls, 0);
});

test("an alive coordinator escalates its process group after the grace period", { skip: process.platform === "win32" }, async () => {
	const signals: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
	const originalKill = process.kill;
	process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
		signals.push({ pid, signal });
		return true;
	}) as typeof process.kill;
	try {
		terminateOwnedTree(
			{
				pid: 4321,
				exitCode: null,
				signalCode: null,
				kill: () => true,
				once: () => undefined,
			},
			10,
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
	} finally {
		process.kill = originalKill;
	}
	assert.deepEqual(signals, [
		{ pid: -4321, signal: "SIGTERM" },
		{ pid: -4321, signal: 0 },
		{ pid: -4321, signal: "SIGKILL" },
	]);
});

test("group escalation kills a SIGTERM-ignoring descendant after the coordinator exits", { skip: process.platform === "win32" }, async () => {
	const grandchildPidFile = path.join(tempRoot(), "ignoring-grandchild.pid");
	const coordinatorPidFile = path.join(tempRoot(), "ignoring-coordinator.pid");
	const grandchildReadyFile = path.join(tempRoot(), "ignoring-grandchild.ready");
	const coordinator = spawn(treePiPath, [], {
		detached: true,
		stdio: ["ignore", "ignore", "ignore"],
		env: {
			...process.env,
			TREE_COORDINATOR_PID_FILE: coordinatorPidFile,
			TREE_GRANDCHILD_PID_FILE: grandchildPidFile,
			TREE_GRANDCHILD_SCRIPT: treeIgnoreSigtermScript,
			TREE_GRANDCHILD_READY_FILE: grandchildReadyFile,
		},
	});
	let grandchildPid: number | undefined;
	try {
		await waitForPidFile(coordinatorPidFile);
		await waitForPidFile(grandchildPidFile);
		await waitForFile(grandchildReadyFile);
		const coordinatorPid = readPid(coordinatorPidFile);
		const descendantPid = readPid(grandchildPidFile);
		grandchildPid = descendantPid;
		assert.equal(coordinator.pid, coordinatorPid);
		assert.notEqual(descendantPid, coordinatorPid);
		assert.ok(isProcessAlive(coordinatorPid), "the coordinator must be alive before termination");
		assert.ok(isProcessAlive(descendantPid), "the SIGTERM-ignoring descendant must be alive before termination");
		terminateOwnedTree(coordinator, 500);
		await waitUntil(() => !isProcessAlive(coordinatorPid), 1_000);
		assert.ok(isProcessAlive(descendantPid), "the descendant must survive SIGTERM after the coordinator exits");
		await waitUntil(() => !isProcessAlive(descendantPid), 2_000);
	} finally {
		if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
		if (coordinator.exitCode === null && coordinator.signalCode === null) {
			coordinator.kill("SIGKILL");
			await new Promise<void>((resolve) => coordinator.once("close", () => resolve()));
		}
	}
});

test("the owner guard refuses values that would make it useless", () => {
	assert.equal(startOwnerGuard(undefined), undefined);
	assert.equal(startOwnerGuard(""), undefined);
	assert.equal(startOwnerGuard("0"), undefined);
	assert.equal(startOwnerGuard("-1"), undefined);
	// Guarding against yourself never fires and would look like protection that is not there.
	assert.equal(startOwnerGuard(String(process.pid)), undefined);
	// The positive case, without which every assertion above holds for a stub that returns undefined
	// unconditionally — and would keep holding with the whole guard deleted. process.ppid is alive,
	// is not us, and the timer is unref'd, so this starts and disposes nothing else.
	const guard = startOwnerGuard(String(process.ppid));
	assert.equal(typeof guard?.dispose, "function", "a live owner that is not us must produce a guard");
	guard?.dispose();
});

test("invalid owner values are rejected in an isolated process", () => {
	const child = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { startOwnerGuard } from ${JSON.stringify(moduleUrl("../extensions/subagents/process-tree.ts"))};
const guard = startOwnerGuard(process.env.TEST_OWNER_RAW);
if (guard) guard.dispose();
process.stdout.write("completed\\n");
`,
		],
		{ encoding: "utf8", env: { ...process.env, TEST_OWNER_RAW: "not a number" } },
	);
	assert.equal(child.status, 0);
	assert.equal(String(child.stdout).trim(), "completed");
});

test("an owner that is already dead exits before the first poll", async () => {
	const readyFile = path.join(tempRoot(), "dead-owner-ready");
	const goFile = path.join(tempRoot(), "dead-owner-go");
	const survivedFile = path.join(tempRoot(), "dead-owner-survived");
	const child = spawn(process.execPath, [
		"--input-type=module",
		"-e",
		`import { existsSync, writeFileSync } from "node:fs";
import { startOwnerGuard } from ${JSON.stringify(moduleUrl("../extensions/subagents/process-tree.ts"))};
const readyFile = process.env.READY_FILE;
const goFile = process.env.GO_FILE;
writeFileSync(readyFile, "ready");
const timer = setInterval(() => {
  if (!existsSync(goFile)) return;
  clearInterval(timer);
  const hold = setInterval(() => {}, 1000);
  startOwnerGuard("2147483647");
  writeFileSync(process.env.SURVIVED_FILE, "survived");
}, 1);
`,
	], {
		stdio: ["ignore", "ignore", "ignore"],
		env: { ...process.env, READY_FILE: readyFile, GO_FILE: goFile, SURVIVED_FILE: survivedFile },
	});
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("close", (code: number | null) => resolve(code));
		child.once("error", reject);
	});
	try {
		await waitForFile(readyFile);
		const startedAt = Date.now();
		writeFileSync(goFile, "go");
		const code = await Promise.race([
			exited,
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_500)),
		]);
		const elapsed = Date.now() - startedAt;
		assert.notEqual(code, "timeout", "dead-owner child did not exit");
		assert.equal(code, 0);
		assert.equal(existsSync(survivedFile), false);
		assert.ok(elapsed < 450, `dead-owner startup took ${elapsed}ms`);
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
	}
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

test("the coordinator schema cannot express the modes it must not use", () => {
	const params = makeNestedSubagentParams([cheapModel], "p/cheap");
	const keys = Object.keys(params.properties);
	// typebox 1.x declares TSchema as an empty interface, so the runtime shape is not on the type.
	// The existing suite gets away with `.enum` because harness.tools is a Map<string, any>;
	// calling the builder directly is typed, and a bare `.enum` will not compile.
	for (const forbidden of ["chain", "async", "action", "id", "resume", "agentScope", "confirmProjectAgents", "cwd"])
		assert.ok(!keys.includes(forbidden), `${forbidden} must be absent from the nested schema`);
	for (const required of ["agent", "task", "tasks", "model", "thinking", "context"])
		assert.ok(keys.includes(required), `${required} must remain available`);
	// A nested task item must not reintroduce cwd through the back door.
	assert.ok(!Object.keys(params.properties.tasks.items.properties).includes("cwd"));
});

test("the nested model enum is the root's scope, not the local catalogue", () => {
	// This is the evidence the model ceiling is load-bearing. A coordinator is spawned with
	// --model and never --models, so its own ctx.scopedModels is empty and modelChoices() would
	// otherwise hand it the entire catalogue one level down from a scoped root.
	const local = [cheapModel, dearModel];
	const params = makeNestedSubagentParams(intersectModelCeiling(local, ["p/cheap"]), "p/cheap");
	assert.deepEqual((params.properties.model as unknown as { enum?: string[] }).enum, ["p/cheap"]);
});

test("an empty model ceiling refuses rather than falling back to free-form", () => {
	// modelSchema falls back to an unconstrained Type.String when `choices` is empty, and
	// run-agent's execution-time check guards on `scopedModels?.length` — falsy for []. So an
	// empty intersection would fail OPEN at both layers: no enum, and no backstop. The spec says
	// the opposite in as many words: an empty array is never read as "unrestricted".
	assert.equal((makeNestedSubagentParams([], undefined).properties.model as unknown as { enum?: string[] }).enum, undefined);
	// Therefore the empty case must never reach schema construction; Step 4 refuses it upstream.
	assert.equal(nestedRegistrationAllowed({ localChoices: [cheapModel], ceiling: ["p/absent"] }), false);
	assert.equal(nestedRegistrationAllowed({ localChoices: [cheapModel], ceiling: ["p/cheap"] }), true);
	assert.equal(nestedRegistrationAllowed({ localChoices: [cheapModel], ceiling: null }), true);
});

test("nested registration leaves only contact_supervisor when the model ceiling is empty", () => {
	const runtime = encodeNestedRuntime({
		version: 1,
		depth: 1,
		agent: "reviewer",
		allowedAgents: ["recon"],
		toolCeiling: null,
		modelCeiling: ["p/absent"],
		budget: { maxSpawns: 4, maxConcurrency: 2 },
	});
	assert.deepEqual([...registerAt("1", runtime)], ["contact_supervisor"]);
});

test("nested registration wires the model ceiling into the registered schema", async () => {
	const coordinatorContext = makeContext();
	const contextValue = coordinatorContext as unknown as TestContext;
	const dear = {
		...contextValue.model,
		id: "dear",
		name: "Dear",
		cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
	};
	contextValue.modelRegistry = {
		getAvailable: () => [contextValue.model, dear],
		find: () => contextValue.model,
	};
	const runtime = encodeNestedRuntime({
		version: 1,
		depth: 1,
		agent: "reviewer",
		allowedAgents: ["recon"],
		toolCeiling: null,
		modelCeiling: ["test-provider/cheap"],
		budget: { maxSpawns: 4, maxConcurrency: 2 },
	});
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	const previousRuntime = process.env[RUNTIME_ENV_VAR];
	process.env.PI_SUBAGENT_DEPTH = "1";
	process.env[RUNTIME_ENV_VAR] = runtime;
	try {
		await harness.refresh(coordinatorContext);
		const tool = harness.tools.get("subagent") as
			| { parameters?: { properties?: Record<string, unknown> } }
			| undefined;
		assert.ok(tool, "nested subagent should be registered");
		assert.deepEqual(
			(tool.parameters?.properties?.model as { enum?: string[] }).enum,
			["test-provider/cheap"],
		);
	} finally {
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		if (previousRuntime === undefined) delete process.env[RUNTIME_ENV_VAR];
		else process.env[RUNTIME_ENV_VAR] = previousRuntime;
	}
});

test("an empty tasks array still consumes one nested spawn budget claim", async () => {
	const runtime = envelopeWith({ maxSpawns: 1, maxConcurrency: 1 });
	const capture = path.join(root, "nested-empty-tasks-budget-capture.jsonl");
	setFakeMode("normal", capture);
	try {
		const results: unknown[] = [];
		for (let i = 0; i < 4; i++) {
			results.push(await executeNested({ agent: "recon", task: `empty-${i}`, tasks: [] }, runtime));
		}
		assert.deepEqual(
			{
				statuses: results.map((result) => (/budget/i.test(resultText(result)) ? "budget" : "ok")),
				spawns: spawnCount(capture),
			},
			{ statuses: ["ok", "budget", "budget", "budget"], spawns: 1 },
		);
	} finally {
		delete process.env.FAKE_PI_CAPTURE;
	}
});

test("parallel claims consume the task count across calls and shapes", async () => {
	const runtime = envelopeWith({ maxSpawns: 3, maxConcurrency: 2 });
	const capture = path.join(root, "nested-cumulative-budget-capture.jsonl");
	setFakeMode("normal", capture);
	try {
		const first = await executeNested(
			{
				tasks: [
					{ agent: "recon", task: "parallel-a" },
					{ agent: "recon", task: "parallel-b" },
				],
			},
			runtime,
		);
		assert.match(resultText(first), /Parallel: 2\/2 succeeded/);

		const refused = await executeNested(
			{
				tasks: [
					{ agent: "recon", task: "parallel-c" },
					{ agent: "recon", task: "parallel-d" },
				],
			},
			runtime,
		);
		assert.match(resultText(refused), /budget/i);

		const emptyArraySingle = await executeNested(
			{ agent: "recon", task: "empty-array-single", tasks: [] },
			runtime,
		);
		assert.match(resultText(emptyArraySingle), /ok/);

		const exhausted = await executeNested({ agent: "recon", task: "after-budget" }, runtime);
		assert.match(resultText(exhausted), /budget/i);
		assert.equal(spawnCount(capture), 3);
	} finally {
		delete process.env.FAKE_PI_CAPTURE;
	}
});

test("the counter stops a coordinator after maxSpawns", async () => {
	const runtime = envelopeWith({ maxSpawns: 2, maxConcurrency: 2 });
	const capture = path.join(root, "nested-budget-capture.jsonl");
	setFakeMode("normal", capture);
	try {
		assert.match(resultText(await executeNested({ agent: "recon", task: "one" }, runtime)), /ok/);
		assert.match(resultText(await executeNested({ agent: "recon", task: "two" }, runtime)), /ok/);
		const third = await executeNested({ agent: "recon", task: "three" }, runtime);
		assert.match(resultText(third), /budget/i);
		assert.equal(spawnCount(capture), 2, "the third call must not reach spawn");
	} finally {
		delete process.env.FAKE_PI_CAPTURE;
	}
});

test("a failed spawn still consumes its claim", async () => {
	const runtime = envelopeWith({ maxSpawns: 1, maxConcurrency: 1 });
	const restorePath = process.env.PATH;
	process.env.PATH = path.join(tempRoot(), "empty");
	try {
		const failed = await executeNested({ agent: "recon", task: "cannot start" }, runtime);
		assert.match(resultText(failed), /failed|start/i, "the first dispatch must fail to start");
	} finally {
		process.env.PATH = restorePath;
	}
	const second = await executeNested({ agent: "recon", task: "retry" }, runtime);
	assert.match(resultText(second), /budget/i);
});

test("a parallel call over budget is rejected whole, before any child starts", async () => {
	const runtime = envelopeWith({ maxSpawns: 3, maxConcurrency: 2 });
	const capture = path.join(root, "nested-budget-parallel-capture.jsonl");
	setFakeMode("normal", capture);
	try {
		const result = await executeNested(
			{
				tasks: [
					{ agent: "recon", task: "a" },
					{ agent: "recon", task: "b" },
					{ agent: "recon", task: "c" },
					{ agent: "recon", task: "d" },
				],
			},
			runtime,
		);
		assert.match(resultText(result), /3/, "the message must state what remains");
		assert.equal(spawnCount(capture), 0, "nothing may start when the call is refused");
	} finally {
		delete process.env.FAKE_PI_CAPTURE;
	}
});

test("a coordinator's nested budget bypasses the root parallel admission cap", async () => {
	const runtime = envelopeWith({ maxSpawns: 2, maxConcurrency: 2 });
	const capture = path.join(root, "nested-budget-root-cap-capture.jsonl");
	writeUserSettings({ maxParallelTasks: 1 });
	setFakeMode("normal", capture);
	try {
		const result = await executeNested(
			{
				tasks: [
					{ agent: "recon", task: "a" },
					{ agent: "recon", task: "b" },
				],
			},
			runtime,
		);
		assert.match(resultText(result), /Parallel: 2\/2 succeeded/);
		assert.equal(spawnCount(capture), 2);
	} finally {
		clearUserSettings();
		delete process.env.FAKE_PI_CAPTURE;
	}
});

test("nested parallel concurrency is min(maxConcurrency, remaining budget)", async () => {
	const runtime = envelopeWith({ maxSpawns: 6, maxConcurrency: 2 });
	const capture = path.join(root, "nested-concurrency-capture.jsonl");
	const probeFile = path.join(root, "nested-concurrency.jsonl");
	setFakeMode("normal", capture);
	setConcurrencyProbe(probeFile, 60);
	try {
		await executeNested(
			{
				tasks: [
					{ agent: "recon", task: "a" },
					{ agent: "recon", task: "b" },
					{ agent: "recon", task: "c" },
					{ agent: "recon", task: "d" },
				],
			},
			runtime,
		);
		assert.equal(peakConcurrency(probeFile), 2);
	} finally {
		delete process.env.FAKE_PI_CAPTURE;
		delete process.env.FAKE_PI_CONCURRENCY_CAPTURE;
		delete process.env.FAKE_PI_HOLD_MS;
	}
});

test("a refused call consumes no budget", async () => {
	const runtime = envelopeWith({ maxSpawns: 1, maxConcurrency: 1 });
	const capture = path.join(root, "nested-refused-budget-capture.jsonl");
	setFakeMode("normal", capture);
	try {
		const refused = await executeNested({ agent: "not-on-the-list", task: "probe" }, runtime);
		assert.match(resultText(refused), /not callable/i);
		assert.match(resultText(await executeNested({ agent: "recon", task: "probe" }, runtime)), /ok/);
		assert.equal(spawnCount(capture), 1, "the refused call must not reach spawn");
	} finally {
		delete process.env.FAKE_PI_CAPTURE;
	}
});

test("a forbidden nested call consumes no budget", async () => {
	const runtime = envelopeWith({ maxSpawns: 1, maxConcurrency: 1 });
	const capture = path.join(root, "nested-forbidden-budget-capture.jsonl");
	setFakeMode("normal", capture);
	try {
		const refused = await executeNested({ agent: "recon", task: "probe", action: "status" }, runtime);
		assert.match(resultText(refused), /cannot be used here/i);
		assert.match(resultText(await executeNested({ agent: "recon", task: "probe" }, runtime)), /ok/);
		assert.equal(spawnCount(capture), 1, "the forbidden call must not reach spawn");
	} finally {
		delete process.env.FAKE_PI_CAPTURE;
	}
});

test("a nested call carrying a forbidden key is refused", async () => {
	const capture = path.join(root, "nested-forbidden-capture.jsonl");
	setFakeMode("normal", capture);
	try {
		const result = await executeNested({ agent: "recon", task: "probe", action: "status" });
		assert.match(resultText(result), /cannot be used here/);
		assert.equal(spawnCount(capture), 0);
	} finally {
		delete process.env.FAKE_PI_CAPTURE;
	}
});

test("a nested call naming an agent outside the allowlist is refused", async () => {
	const capture = path.join(root, "nested-unknown-capture.jsonl");
	setFakeMode("normal", capture);
	try {
		const result = await executeNested({ agent: "general-purpose", task: "probe" });
		assert.match(resultText(result), /Not callable from here/);
		assert.equal(spawnCount(capture), 0);
	} finally {
		delete process.env.FAKE_PI_CAPTURE;
	}
});

test("coordinator discovery never consults the process project-trust predicate", async () => {
	writeAgentFile("recon", { tools: "read" });
	const coordinatorContext = makeContext();
	const contextValue = coordinatorContext as unknown as TestContext;
	contextValue.isProjectTrusted = () => {
		throw new Error("coordinator discovery must use projectTrusted: false");
	};
	const capture = path.join(root, "nested-project-trust-capture.jsonl");
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	const previousRuntime = process.env[RUNTIME_ENV_VAR];
	process.env.PI_SUBAGENT_DEPTH = "1";
	process.env[RUNTIME_ENV_VAR] = nestedGuardRuntime;
	setFakeMode("normal", capture);
	try {
		await harness.refresh(coordinatorContext);
		const result = await harness.execute({ agent: "recon", task: "probe" }, coordinatorContext);
		assert.match(resultText(result), /ok/);
	} finally {
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		if (previousRuntime === undefined) delete process.env[RUNTIME_ENV_VAR];
		else process.env[RUNTIME_ENV_VAR] = previousRuntime;
		delete process.env.FAKE_PI_CAPTURE;
	}
});

test("a nested task cannot smuggle cwd through its item", async () => {
	writeAgentFile("recon", { tools: "read" });
	const escapeDir = path.join(root, "escape-dir");
	mkdirSync(escapeDir, { recursive: true });
	const capture = path.join(root, "nested-task-cwd-capture.jsonl");
	const cwdCapture = path.join(root, "nested-task-cwd.jsonl");
	process.env.FAKE_PI_CWD_CAPTURE = cwdCapture;
	setFakeMode("normal", capture);
	try {
		const result = await executeNested({
			tasks: [{ agent: "recon", task: "probe", cwd: escapeDir }],
		});
		assert.match(resultText(result), /cwd cannot be used here/);
		assert.equal(spawnCount(capture), 0);
	} finally {
		delete process.env.FAKE_PI_CWD_CAPTURE;
		delete process.env.FAKE_PI_CAPTURE;
	}
});

test("nested model validation leaves an unscoped root's model behavior unchanged", async () => {
	writeAgentFile("recon", { model: "sonnet", tools: "read" });
	const coordinatorContext = makeContext();
	const contextValue = coordinatorContext as unknown as TestContext;
	contextValue.modelRegistry = {
		getAvailable: () => [contextValue.model],
		find: () => undefined,
	};
	const capture = path.join(root, "nested-unscoped-model-capture.jsonl");
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	const previousRuntime = process.env[RUNTIME_ENV_VAR];
	process.env.PI_SUBAGENT_DEPTH = "1";
	process.env[RUNTIME_ENV_VAR] = nestedGuardRuntime;
	setFakeMode("normal", capture);
	try {
		await harness.refresh(coordinatorContext);
		const result = await harness.execute({ agent: "recon", task: "probe" }, coordinatorContext);
		assert.match(resultText(result), /ok/);
		assert.equal(spawnCount(capture), 1);
	} finally {
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		if (previousRuntime === undefined) delete process.env[RUNTIME_ENV_VAR];
		else process.env[RUNTIME_ENV_VAR] = previousRuntime;
		delete process.env.FAKE_PI_CAPTURE;
	}
});

test("nested model ceilings reject a leaf frontmatter model outside the root scope", async () => {
	writeAgentFile("recon", { model: "test-provider/dear", tools: "read" });
	const coordinatorContext = makeContext();
	const contextValue = coordinatorContext as unknown as TestContext;
	const dear = {
		...contextValue.model,
		id: "dear",
		name: "Dear",
		cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
	};
	contextValue.modelRegistry = {
		getAvailable: () => [contextValue.model],
		find: (provider, id) =>
			provider === "test-provider" && id === "dear" ? dear : provider === "test-provider" && id === "cheap" ? contextValue.model : undefined,
	};
	const runtime = encodeNestedRuntime({
		version: 1,
		depth: 1,
		agent: "reviewer",
		allowedAgents: ["recon"],
		toolCeiling: null,
		modelCeiling: ["test-provider/cheap"],
		budget: { maxSpawns: 4, maxConcurrency: 2 },
	});
	const capture = path.join(root, "nested-scoped-frontmatter-model-capture.jsonl");
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	const previousRuntime = process.env[RUNTIME_ENV_VAR];
	process.env.PI_SUBAGENT_DEPTH = "1";
	process.env[RUNTIME_ENV_VAR] = runtime;
	setFakeMode("normal", capture);
	try {
		await harness.refresh(coordinatorContext);
		const result = await harness.execute({ agent: "recon", task: "probe" }, coordinatorContext);
		assert.match(resultText(result), /outside the configured model scope/);
		assert.equal(spawnCount(capture), 0);
	} finally {
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		if (previousRuntime === undefined) delete process.env[RUNTIME_ENV_VAR];
		else process.env[RUNTIME_ENV_VAR] = previousRuntime;
		delete process.env.FAKE_PI_CAPTURE;
	}
});

test("async detaches only agents with a live nested envelope", async () => {
	writeCoordinatorFixtures();
	const capture = path.join(root, "async-without-envelope-capture.jsonl");
	setFakeMode("normal", capture);
	writeUserSettings({ maxNestedSpawns: 0 });
	try {
		const disabled = await runSubagent({ agent: "reviewer", task: "review-disabled", async: true });
		assert.match(resultText(disabled), /Started .*detached/);
		await waitForSpawnCount(capture, 1);
	} finally {
		clearUserSettings();
	}

	writeAgentFile("lonely", { allowNestedSubagents: true, allowedSubagents: "nobody", tools: "read" });
	try {
		const empty = await runSubagent({ agent: "lonely", task: "review-empty", async: true });
		assert.match(resultText(empty), /Started .*detached/);
		await waitForSpawnCount(capture, 2);
	} finally {
		assert.equal(spawnCount(capture), 2);
		assert.deepEqual(
			capturedArgs(capture).map((args) => args[args.length - 1]).sort(),
			["Task: review-disabled", "Task: review-empty"],
		);
		delete process.env.FAKE_PI_CAPTURE;
	}
});

test("a coordinator does not inherit trusted project subagent defaults", async () => {
	const project = path.join(root, "nested-defaults-project");
	mkdirSync(path.join(project, ".pi"), { recursive: true });
	writeFileSync(
		path.join(project, ".pi", "settings.json"),
		JSON.stringify({ subagents: { defaultContext: "fork", defaultThinking: "high", maxThinking: "high" } }),
	);
	writeAgentFile("recon", { tools: "read" });
	const sessionFile = path.join(project, "parent-session.jsonl");
	writeFileSync(sessionFile, "session\n");
	const coordinatorContext = makeContext(project);
	const contextValue = coordinatorContext as unknown as TestContext;
	contextValue.isProjectTrusted = () => true;
	contextValue.sessionManager = { getSessionFile: () => sessionFile };
	const capture = path.join(root, "nested-defaults-capture.jsonl");
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	const previousRuntime = process.env[RUNTIME_ENV_VAR];
	process.env.PI_SUBAGENT_DEPTH = "1";
	process.env[RUNTIME_ENV_VAR] = nestedGuardRuntime;
	setFakeMode("normal", capture);
	try {
		await harness.refresh(coordinatorContext);
		const result = await harness.execute({ agent: "recon", task: "probe" }, coordinatorContext);
		assert.match(resultText(result), /ok/);
		const matches = capturedArgs(capture).filter((args) => args[args.length - 1] === "Task: probe");
		assert.equal(matches.length, 1, "the test must inspect its own child capture entry");
		const args = matches[0];
		assert.equal(optionValue(args, "--fork"), undefined);
		assert.equal(optionValue(args, "--thinking"), "low");
	} finally {
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		if (previousRuntime === undefined) delete process.env[RUNTIME_ENV_VAR];
		else process.env[RUNTIME_ENV_VAR] = previousRuntime;
		delete process.env.FAKE_PI_CAPTURE;
	}
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

test("an ordinary child stays in the root's process group", linuxOnly, async () => {
	const capture = path.join(tempRoot(), "ordinary-pgrp-env.jsonl");
	process.env.FAKE_PI_ENV_CAPTURE = capture;
	setFakeMode("normal", path.join(tempRoot(), "ordinary-pgrp-argv.jsonl"));
	try {
		await runSubagent({ agent: "general-purpose", task: "anything" });
		const seen = capturedEnvironment(capture)[0];
		assert.equal(seen.pgrp, ownPgrp(), "an ordinary child shares the dispatching process's group");
		assert.notEqual(seen.pgrp, seen.pid, "and is therefore not a group leader");
	} finally {
		delete process.env.FAKE_PI_ENV_CAPTURE;
	}
});

test("a coordinator leads its own process group", linuxOnly, async () => {
	writeCoordinatorFixtures();
	const capture = path.join(tempRoot(), "coordinator-pgrp-env.jsonl");
	process.env.FAKE_PI_ENV_CAPTURE = capture;
	setFakeMode("normal", path.join(tempRoot(), "coordinator-pgrp-argv.jsonl"));
	try {
		await runSubagent({ agent: "reviewer", task: "review" });
		const seen = capturedEnvironment(capture)[0];
		assert.notEqual(seen.pgrp, ownPgrp(), "a coordinator must leave the root's group to signal its own");
		assert.equal(seen.pgrp, seen.pid, "a coordinator must be its own group leader");
	} finally {
		delete process.env.FAKE_PI_ENV_CAPTURE;
	}
});

test("aborting a coordinator run leaves no grandchild alive", { skip: process.platform === "win32" }, async () => {
	const pidFile = path.join(tempRoot(), "grandchild.pid");
	// A fixture grandchild records its pid and waits; the root call is then aborted.
	const { controller, running } = beginCoordinatorWithGrandchild(pidFile);
	let pid: number | undefined;
	try {
		await waitForPidFile(pidFile);
		pid = readPid(pidFile);
		assert.ok(isProcessAlive(pid), "the grandchild must be alive before the abort");
		controller.abort();
		await running;
		await waitUntil(() => !isProcessAlive(pid as number), 10_000);
	} finally {
		controller.abort();
		if (pid !== undefined && isProcessAlive(pid)) process.kill(pid, "SIGKILL");
		await running;
	}
});

test("a grandchild exits on its own when its coordinator dies abruptly", { skip: process.platform === "win32" }, async () => {
	// The owner guard, not the signal path: nothing signals this grandchild.
	const pidFile = path.join(tempRoot(), "orphan.pid");
	const coordinatorPid = await startCoordinatorThenSigkillIt(pidFile);
	const pid = readPid(pidFile);
	try {
		assert.notEqual(pid, coordinatorPid);
		await waitUntil(() => !isProcessAlive(pid), 10_000);
	} finally {
		if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
	}
});

test("session shutdown disposes the owner guard", { skip: process.platform === "win32" }, async () => {
	const pidFile = path.join(tempRoot(), "disposed-grandchild.pid");
	const coordinatorPidFile = path.join(tempRoot(), "disposed-coordinator.pid");
	const shutdownFile = path.join(tempRoot(), "guard-disposed");
	const { controller, running } = beginCoordinatorWithGrandchild(pidFile, true, coordinatorPidFile, shutdownFile);
	let coordinatorPid: number | undefined;
	let grandchildPid: number | undefined;
	try {
		await waitForFile(shutdownFile);
		await waitForPidFile(coordinatorPidFile);
		await waitForPidFile(pidFile);
		coordinatorPid = readPid(coordinatorPidFile);
		grandchildPid = readPid(pidFile);
		assert.ok(isProcessAlive(grandchildPid), "the guarded grandchild must be alive before shutdown");
		process.kill(coordinatorPid, "SIGKILL");
		await running;
		await new Promise((resolve) => setTimeout(resolve, 750));
		assert.ok(isProcessAlive(grandchildPid), "a disposed guard must not kill its child after owner death");
	} finally {
		if (coordinatorPid !== undefined && isProcessAlive(coordinatorPid)) process.kill(coordinatorPid, "SIGKILL");
		if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
		controller.abort();
		await running;
	}
});

test("a coordinator cannot be dispatched async from the root", async () => {
	writeCoordinatorFixtures();
	const capture = path.join(root, "coordinator-async-capture.jsonl");
	setFakeMode("normal", capture);
	try {
		const result = await runSubagent({ agent: "reviewer", task: "review", async: true });
		assert.match(resultText(result), /synchronously/);
		assert.equal(spawnCount(capture), 0);
	} finally {
		delete process.env.FAKE_PI_CAPTURE;
	}
});

test("the coordinator re-checks the tool ceiling against the file it actually resolved", async () => {
	writeAgentFile("reviewer", {
		allowNestedSubagents: true,
		allowedSubagents: "recon",
		tools: "read,grep",
	});
	writeAgentFile("recon", { tools: "read,grep" });
	const runtime = encodeNestedRuntime({
		version: 1,
		depth: 1,
		agent: "reviewer",
		allowedAgents: ["recon"],
		toolCeiling: ["read", "grep"],
		modelCeiling: null,
		budget: { maxSpawns: 4, maxConcurrency: 2 },
	});
	const capture = path.join(root, "nested-ceiling-capture.jsonl");
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_SUBAGENT_DEPTH = "1";
	process.env[RUNTIME_ENV_VAR] = runtime;
	setFakeMode("normal", capture);
	try {
		await harness.refresh(context);
		const registered = harness.tools.get("subagent") as { description?: string } | undefined;
		assert.match(registered?.description ?? "", /bounded verification probe/);
		// Root validated recon at launch. Between then and the nested dispatch, recon gains `write`.
		writeAgentFile("recon", { tools: "read,grep,write" });
		const result = await harness.execute({ agent: "recon", task: "probe" }, context);
		assert.match(resultText(result), /beyond this run's ceiling/);
		assert.equal(spawnCount(capture), 0);
	} finally {
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		delete process.env[RUNTIME_ENV_VAR];
		delete process.env.FAKE_PI_CAPTURE;
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
		const output = resultText(result);
		assert.match(output, /\[Nested delegation notes\]/, "delegation notes must reach the visible output");
		assert.match(output, /Nested delegation: dropped "nobody"/, "the drop must be reported visibly");
		assert.match(output, /nothing survived, running as an ordinary agent/, "the fallback must be reported visibly");
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

test("coordinator authority resolves against the user scope, not project shadows", async () => {
	writeCoordinatorFixtures();
	const project = path.join(root, "authority-scope-project");
	const projectAgents = path.join(project, ".pi", "agents");
	writeAgentFile("recon", { tools: "read,write" }, projectAgents);
	const capture = path.join(root, "authority-scope-env.jsonl");
	const argvCapture = path.join(root, "authority-scope-argv.jsonl");
	process.env.FAKE_PI_ENV_CAPTURE = capture;
	setFakeMode("normal", argvCapture);
	try {
		await runSubagent(
			{ agent: "reviewer", task: "review this", agentScope: "both" },
			makeContext(project),
		);
		const seen = capturedEnvironment(capture)[0];
		const runtime = parseNestedRuntime(seen.runtime || undefined);
		assert.ok(runtime, "the user-scope delegate must survive project shadowing");
		assert.deepEqual(runtime.allowedAgents, ["recon"]);
	} finally {
		delete process.env.FAKE_PI_ENV_CAPTURE;
	}
});

test("a resumed coordinator keeps its original allowlist after its agent file changes", async () => {
	writeCoordinatorFixtures();
	const coordinatorContext = makeContext(root, true);
	const first = await runSubagent({ agent: "reviewer", task: "review" }, coordinatorContext);
	const runId = runIdOf(first);
	writeAgentFile("reviewer", { allowNestedSubagents: true, allowedSubagents: "general-purpose", tools: "read" });
	const capture = path.join(tempRoot(), "env.jsonl");
	const argvCapture = path.join(root, "resume-contract-argv.jsonl");
	process.env.FAKE_PI_ENV_CAPTURE = capture;
	setFakeMode("normal", argvCapture);
	try {
		await runSubagent({ resume: runId, task: "carry on" }, coordinatorContext);
		const seen = JSON.parse(readFileSync(capture, "utf8").trim().split("\n")[0]) as { runtime: string };
		const runtime = parseNestedRuntime(seen.runtime);
		assert.deepEqual(runtime?.allowedAgents, ["recon"], "authority comes from the stored contract, not the file");
		assert.deepEqual(runtime?.toolCeiling, ["read", "grep", "find", "ls", "bash"]);
		assert.deepEqual(runtime?.modelCeiling, ["test-provider/cheap"]);
	} finally {
		delete process.env.FAKE_PI_ENV_CAPTURE;
	}
});

test("a run retained without a stored contract resumes with no delegation", async () => {
	const runId = retainRunWithoutContract("reviewer");
	const capture = path.join(tempRoot(), "env.jsonl");
	const argvCapture = path.join(root, "legacy-resume-argv.jsonl");
	process.env.FAKE_PI_ENV_CAPTURE = capture;
	setFakeMode("normal", argvCapture);
	try {
		await runSubagent({ resume: runId, task: "carry on" });
		const seen = JSON.parse(readFileSync(capture, "utf8").trim().split("\n")[0]) as { runtime: string };
		assert.equal(seen.runtime, "");
	} finally {
		delete process.env.FAKE_PI_ENV_CAPTURE;
	}
});

test("a resumed coordinator keeps its stored authority while nesting is disabled", async () => {
	writeCoordinatorFixtures();
	const first = await runSubagent({ agent: "reviewer", task: "review" });
	const runId = runIdOf(first);
	writeUserSettings({ maxNestedSpawns: 0 });
	try {
		await runSubagent({ resume: runId, task: "carry on while disabled" });
	} finally {
		clearUserSettings();
	}
	const capture = path.join(tempRoot(), "reenabled-env.jsonl");
	const argvCapture = path.join(root, "reenabled-argv.jsonl");
	process.env.FAKE_PI_ENV_CAPTURE = capture;
	setFakeMode("normal", argvCapture);
	try {
		await runSubagent({ resume: runId, task: "carry on again" });
		const seen = JSON.parse(readFileSync(capture, "utf8").trim().split("\n")[0]) as { runtime: string };
		const runtime = parseNestedRuntime(seen.runtime);
		assert.deepEqual(runtime?.allowedAgents, ["recon"]);
	} finally {
		delete process.env.FAKE_PI_ENV_CAPTURE;
	}
});

test("a depth-1 process emits no envelope for its own child", async () => {
	writeAgentFile("reviewer", {
		allowNestedSubagents: true,
		allowedSubagents: "depth-one-coordinator",
		tools: "read,grep,find,ls,bash",
	});
	writeAgentFile("depth-one-coordinator", {
		allowNestedSubagents: true,
		allowedSubagents: "recon",
		tools: "read,grep,find,ls,bash",
	});
	const capture = path.join(root, "depth-one-env.jsonl");
	const argvCapture = path.join(root, "depth-one-argv.jsonl");
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	const previousRuntime = process.env[RUNTIME_ENV_VAR];
	const depthOneRuntime = encodeNestedRuntime({
		version: 1,
		depth: 1,
		agent: "reviewer",
		allowedAgents: ["depth-one-coordinator"],
		toolCeiling: ["read", "grep", "find", "ls", "bash"],
		modelCeiling: null,
		budget: { maxSpawns: 4, maxConcurrency: 2 },
	});
	process.env.PI_SUBAGENT_DEPTH = "1";
	process.env[RUNTIME_ENV_VAR] = depthOneRuntime;
	process.env.FAKE_PI_ENV_CAPTURE = capture;
	setFakeMode("normal", argvCapture);
	try {
		await runSubagent({ agent: "depth-one-coordinator", task: "child" });
		const seen = capturedEnvironment(capture)[0];
		assert.equal(seen.depth, "2");
		assert.equal(seen.runtime, "", "only the root may emit an envelope");
	} finally {
		delete process.env.FAKE_PI_ENV_CAPTURE;
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		if (previousRuntime === undefined) delete process.env[RUNTIME_ENV_VAR];
		else process.env[RUNTIME_ENV_VAR] = previousRuntime;
	}
});

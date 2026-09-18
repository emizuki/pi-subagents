import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
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
			JSON.stringify({ subagents: { maxNestedSpawns: "lots", maxNestedConcurrency: 99 } }),
		);
		const settings = readSubagentSettings(root, undefined);
		assert.equal(settings.maxNestedSpawns, DEFAULT_MAX_NESTED_SPAWNS);
		assert.equal(settings.maxNestedConcurrency, DEFAULT_MAX_NESTED_CONCURRENCY);
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
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { maxNestedSpawns: 4 } }));
		const projectFile = path.join(project, ".pi", "settings.json");
		const trusted = { file: projectFile, root: project };

		writeFileSync(projectFile, JSON.stringify({ subagents: { maxNestedSpawns: 12 } }));
		assert.equal(readSubagentSettings(project, trusted).maxNestedSpawns, 4, "a project must not raise the cap");

		writeFileSync(projectFile, JSON.stringify({ subagents: { maxNestedSpawns: 1 } }));
		assert.equal(readSubagentSettings(project, trusted).maxNestedSpawns, 1, "a project may lower the cap");

		// The spec requires both limits, and the two use different parsers and ranges.
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

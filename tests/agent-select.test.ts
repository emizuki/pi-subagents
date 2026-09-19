import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../extensions/subagents/agents.ts";
import { delegateProvenance } from "../extensions/subagents/agent-select.ts";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "recon",
		aliases: [],
		description: "test agent",
		inheritSkills: false,
		inheritProjectContext: true,
		suggest: true,
		allowNestedSubagents: false,
		allowedSubagents: [],
		systemPrompt: "",
		source: "builtin",
		filePath: "/builtin/agents/recon.md",
		...overrides,
	};
}

test("delegateProvenance leaves a builtin delegate unannotated", () => {
	assert.equal(delegateProvenance(agent({ source: "builtin" })), "recon");
});

// Pins the deviation from repoControlledSource's own fallback: `packageRoot` and `packageName`
// are both undefined for a plain user file, so reusing that chain verbatim would render
// "recon ((unknown package))" -- a false statement about a file that is not a package at all,
// for a source discoverAgents resolves *after* both builtin and package (agents.ts's `put()`
// order), so a plain user file can shadow either one exactly like a package can.
test("delegateProvenance names a plain user-scope file by its path, not a package label", () => {
	const filePath = "/home/u/.pi/agents/agents/recon.md";
	assert.equal(delegateProvenance(agent({ source: "user", name: "recon", filePath })), `recon (${filePath})`);
});

// Same fallback branch, same reasoning, for the other source repoControlledSource does not
// special-case: `packageRoot`/`packageName` are undefined for a project file too.
test("delegateProvenance names a plain project-scope file by its path, not a package label", () => {
	const filePath = "/repo/.pi/agents/recon.md";
	assert.equal(delegateProvenance(agent({ source: "project", name: "recon", filePath })), `recon (${filePath})`);
});

test("delegateProvenance still names a package delegate by its package root", () => {
	assert.equal(
		delegateProvenance(
			agent({
				source: "package",
				packageRoot: "/home/u/.pi/npm/node_modules/some-pkg",
				filePath: "/home/u/.pi/npm/node_modules/some-pkg/agents/recon.md",
			}),
		),
		"recon (/home/u/.pi/npm/node_modules/some-pkg)",
	);
});

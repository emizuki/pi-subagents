import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { renderSubagentResult } from "../extensions/subagents/render.ts";
import type { SingleResult, SubagentDetails } from "../extensions/subagents/results.ts";

// `ToolRenderContext` is not re-exported from the package root; derived from the function's own
// signature instead of guessing at an internal type path.
type RenderResultParams = Parameters<typeof renderSubagentResult>;
type RenderResultOptions = RenderResultParams[1];
type RenderResultContext = RenderResultParams[3];

/**
 * Records which theme colour each fragment was wrapped in instead of emitting real ANSI, so
 * assertions can check "rendered in the warning colour" without depending on escape sequences.
 * `renderSubagentResult` and its helpers only ever call `.fg()` and `.bold()` on the theme.
 */
function fakeTheme(): Theme {
	const fg = (color: string, text: string) => `<${color}>${text}</${color}>`;
	return { fg, bold: (text: string) => text } as unknown as Theme;
}

const collapsed: RenderResultOptions = { expanded: false, isPartial: false };
const expanded: RenderResultOptions = { expanded: true, isPartial: false };
const unusedContext = {} as RenderResultContext;

function singleResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "recon",
		agentSource: "builtin",
		task: "probe",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

function toolResult(details: SubagentDetails): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: "ok" }], details };
}

function renderText(component: Component): string {
	return component.render(200).join("\n");
}

test("a delegation drop note renders in the warning colour on a collapsed single result", () => {
	const r = singleResult({ outputNotes: [`Nested delegation: dropped "recon" — model not found.`] });
	const details: SubagentDetails = { mode: "single", agentScope: "user", projectAgentsDir: null, results: [r] };
	const component = renderSubagentResult(toolResult(details), collapsed, fakeTheme(), unusedContext);
	assert.match(renderText(component), /<warning>⚠ Nested delegation: dropped "recon" — model not found\.<\/warning>/);
});

test("a delegation drop note renders in the warning colour on an expanded single result", () => {
	const r = singleResult({ outputNotes: ["Nested delegation: nothing survived, running as an ordinary agent."] });
	const details: SubagentDetails = { mode: "single", agentScope: "user", projectAgentsDir: null, results: [r] };
	const component = renderSubagentResult(toolResult(details), expanded, fakeTheme(), unusedContext);
	assert.match(
		renderText(component),
		/<warning>⚠ Nested delegation: nothing survived, running as an ordinary agent\.<\/warning>/,
	);
});

test("a successful single result with no delegation notes renders with no warning marker", () => {
	const r = singleResult();
	const details: SubagentDetails = { mode: "single", agentScope: "user", projectAgentsDir: null, results: [r] };
	const component = renderSubagentResult(toolResult(details), collapsed, fakeTheme(), unusedContext);
	assert.doesNotMatch(renderText(component), /⚠|<warning>/);
});

test("a delegation drop note renders in the warning colour on a collapsed parallel result", () => {
	const dropped = singleResult({
		agent: "reviewer",
		outputNotes: [`Nested delegation: dropped "recon" — model not found.`],
	});
	const clean = singleResult({ agent: "general-purpose" });
	const details: SubagentDetails = {
		mode: "parallel",
		agentScope: "user",
		projectAgentsDir: null,
		results: [dropped, clean],
	};
	const component = renderSubagentResult(toolResult(details), collapsed, fakeTheme(), unusedContext);
	assert.match(renderText(component), /<warning>⚠ Nested delegation: dropped "recon" — model not found\.<\/warning>/);
});

test("a parallel result with no delegation notes renders with no warning marker", () => {
	const results = [singleResult({ agent: "reviewer" }), singleResult({ agent: "general-purpose" })];
	const details: SubagentDetails = { mode: "parallel", agentScope: "user", projectAgentsDir: null, results };
	const component = renderSubagentResult(toolResult(details), collapsed, fakeTheme(), unusedContext);
	assert.doesNotMatch(renderText(component), /⚠|<warning>/);
});

test("a delegation drop note renders in the warning colour on a collapsed chain result", () => {
	const r = singleResult({ agent: "lonely", step: 1, outputNotes: ["Nested delegation: nothing survived, running as an ordinary agent."] });
	const details: SubagentDetails = { mode: "chain", agentScope: "user", projectAgentsDir: null, results: [r] };
	const component = renderSubagentResult(toolResult(details), collapsed, fakeTheme(), unusedContext);
	assert.match(
		renderText(component),
		/<warning>⚠ Nested delegation: nothing survived, running as an ordinary agent\.<\/warning>/,
	);
});

test("a delegation drop note renders in the warning colour on an expanded chain result", () => {
	const r = singleResult({ agent: "lonely", step: 1, outputNotes: ["Nested delegation: nothing survived, running as an ordinary agent."] });
	const details: SubagentDetails = { mode: "chain", agentScope: "user", projectAgentsDir: null, results: [r] };
	const component = renderSubagentResult(toolResult(details), expanded, fakeTheme(), unusedContext);
	assert.match(
		renderText(component),
		/<warning>⚠ Nested delegation: nothing survived, running as an ordinary agent\.<\/warning>/,
	);
});

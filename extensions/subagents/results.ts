import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { AgentScope, AgentSource } from "./agents.ts";

export const OUTPUT_NOTICE_RESERVE_BYTES = 1024;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	/** Retained-run id, so a caller can resume this particular step or task later. */
	runId?: string;
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	/** Coordinator diagnostics that must remain visible even when the child exits successfully. */
	outputNotes?: string[];
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export const aggregateUsage = (results: SingleResult[]) => {
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

/** Only `cost.total` is read back by the parent's rollup; the per-channel costs are not
 * reconstructible from a usage total and are reported as zero rather than invented.
 * Parameter typed structurally, not as UsageStats: aggregateUsage has no contextTokens. */
export function toUsage(stats: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }): Usage {
	return {
		input: stats.input,
		output: stats.output,
		cacheRead: stats.cacheRead,
		cacheWrite: stats.cacheWrite,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: stats.cost },
	};
}

export const TOOL_RESULT_META_KEY = "__piSubagents";

export interface ToolResultMetadata {
	failed?: true;
	/** Full model-visible text when the returned content had to be truncated. */
	fullOutput?: string;
}

export interface ToolResultDraft<T = unknown> {
	content: Array<{ type: "text"; text: string }>;
	details?: T;
	usage?: AgentToolResult<T>["usage"];
	addedToolNames?: string[];
	terminate?: boolean;
	/** Internal flag consumed by finalizeToolResult; never returned as a fake AgentToolResult field. */
	failed?: boolean;
}

export type DetailsWithMetadata<T> = T & { [TOOL_RESULT_META_KEY]?: ToolResultMetadata };
export type MetadataOnlyDetails = { [TOOL_RESULT_META_KEY]: ToolResultMetadata };

/**
 * The details type of the subagent tool registration.
 *
 * Named here rather than inferred at the call site because `render.ts` must state it explicitly:
 * a standalone renderer has no object literal to infer it from. It is `unknown` because that is
 * what the object literal itself infers: `dispatch.ts`'s `execute` threads its result through
 * `finalizeToolResult()` from inside an inner function whose own return type is annotated
 * `Promise<ToolResultDraft<unknown>>`, and `AgentToolResult<T>` declares `details: T` non-optional
 * — so `unknown` is what actually reaches this slot. The renderers narrow `result.details` with
 * their own cast instead of relying on it.
 *
 * That inner annotation is also why pinning this narrower does not fail where you would expect.
 * The break is in `execute`'s own return type, not `onUpdate`: `DetailsWithMetadata<unknown>`
 * collapses to the bare, all-optional `{ __piSubagents?: ToolResultMetadata }`, which has none of
 * `SubagentDetails`'s required fields — no narrower union accepts it unless that inner annotation
 * loosens too.
 */
export type SubagentToolDetails = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function utf8Prefix(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let end = maxBytes;
	// A UTF-8 continuation byte cannot begin the remainder. Back up to the code-point boundary
	// instead of letting Buffer.toString manufacture U+FFFD at the cut.
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function truncateWithLongLineFallback(text: string, maxBytes: number, maxLines: number) {
	const truncated = truncateHead(text, { maxBytes, maxLines });
	if (!truncated.truncated || truncated.content || !text) return truncated;
	// Pi's line-preserving helper intentionally emits no content when the first line alone exceeds
	// maxBytes. Model output often contains minified JSON or generated blobs, where a byte-safe
	// prefix is much more useful than an empty response.
	const content = utf8Prefix(text, maxBytes);
	return {
		...truncated,
		content,
		outputBytes: Buffer.byteLength(content, "utf8"),
		outputLines: content ? content.split("\n").length : 0,
	};
}

function resumableRunSummary(details: unknown): string | undefined {
	if (!isRecord(details) || !Array.isArray(details.results)) return undefined;
	const runIds = details.results.flatMap((value: unknown) =>
		isRecord(value) && typeof value.runId === "string" ? [value.runId] : [],
	);
	if (runIds.length === 0) return undefined;
	const shown = runIds.slice(0, 8).map((id) => `run ${id}`);
	if (runIds.length > shown.length) shown.push(`+${runIds.length - shown.length} more; use { action: "runs" }`);
	return shown.join(", ");
}

function textLineCount(text: string): number {
	return text ? text.split("\n").length : 0;
}

export function truncateModelText(text: string, details: unknown): { text: string; fullOutput?: string } {
	const probe = truncateWithLongLineFallback(text, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES);
	if (!probe.truncated) return { text };

	// Keep run ids model-visible because they are needed to resume a child and normally appear at
	// the tail that head truncation removes. The summary is bounded independently of agent names.
	const runs = resumableRunSummary(details);
	let payloadBytes = DEFAULT_MAX_BYTES - OUTPUT_NOTICE_RESERVE_BYTES;
	let payloadLines = DEFAULT_MAX_LINES - 2;
	let lastNotice = "";
	for (let attempt = 0; attempt < 4; attempt++) {
		const truncated = truncateWithLongLineFallback(text, Math.max(1, payloadBytes), Math.max(1, payloadLines));
		lastNotice = `[Output truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}). Full output preserved in tool details.${runs ? ` Resumable: ${runs}.` : ""}]`;
		const separator = truncated.content ? "\n\n" : "";
		const output = `${truncated.content}${separator}${lastNotice}`;
		const excessBytes = Math.max(0, Buffer.byteLength(output, "utf8") - DEFAULT_MAX_BYTES);
		const excessLines = Math.max(0, textLineCount(output) - DEFAULT_MAX_LINES);
		if (excessBytes === 0 && excessLines === 0) return { text: output, fullOutput: text };
		payloadBytes = Math.max(1, payloadBytes - excessBytes);
		payloadLines = Math.max(1, payloadLines - excessLines);
	}

	// Defensive final fallback. The bounded, single-line notice itself is far below both limits,
	// even if a future formatting change makes the iterative payload budget fail to converge.
	return {
		text: utf8Prefix(lastNotice.replace(/\n/g, " "), DEFAULT_MAX_BYTES),
		fullOutput: text,
	};
}

/**
 * Normalize every custom-tool return through the actual AgentToolResult contract.
 *
 * Pi deliberately ignores an `isError` property returned by execute(); the tool_result bridge
 * below reads our details marker and sets the real event flag while preserving rich details.
 */
export function finalizeToolResult<T>(draft: ToolResultDraft<T>): AgentToolResult<DetailsWithMetadata<T> | MetadataOnlyDetails | undefined> {
	const originalText = draft.content.map((part) => part.text).join("\n");
	const bounded = truncateModelText(originalText, draft.details);
	const metadata: ToolResultMetadata = {
		...(draft.failed ? { failed: true as const } : {}),
		...(bounded.fullOutput === undefined ? {} : { fullOutput: bounded.fullOutput }),
	};
	const hasMetadata = Object.keys(metadata).length > 0;
	let details: DetailsWithMetadata<T> | MetadataOnlyDetails | undefined = draft.details as DetailsWithMetadata<T> | undefined;
	if (hasMetadata) {
		details = isRecord(draft.details)
			? ({ ...draft.details, [TOOL_RESULT_META_KEY]: metadata } as DetailsWithMetadata<T>)
			: { [TOOL_RESULT_META_KEY]: metadata };
	}
	return {
		content: [{ type: "text", text: bounded.text }],
		details,
		...(draft.usage === undefined ? {} : { usage: draft.usage }),
		...(draft.addedToolNames === undefined ? {} : { addedToolNames: draft.addedToolNames }),
		...(draft.terminate === undefined ? {} : { terminate: draft.terminate }),
	};
}

export function toolResultMetadata(details: unknown): ToolResultMetadata | undefined {
	if (!isRecord(details)) return undefined;
	const metadata = details[TOOL_RESULT_META_KEY];
	return isRecord(metadata) ? (metadata as ToolResultMetadata) : undefined;
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		return msg.content
			.filter((part): part is Extract<(typeof msg.content)[number], { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("");
	}
	return "";
}

/** In flight: the live result object is published while the child runs, and carries -1 until close. */
export function isRunningResult(result: SingleResult): boolean {
	return result.exitCode === -1;
}

export function isFailedResult(result: SingleResult): boolean {
	// A run still going is not a failed run. It was rendered as one after the live object started
	// at -1 to stop parallel counting an unfinished task as done: every dispatch then drew ✗ and a
	// [toolUse] tag while it worked, and flipped to ✓ at the end.
	if (isRunningResult(result)) return false;
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function appendOutputNotes(output: string, notes: string[] | undefined): string {
	if (!notes || notes.length === 0) return output;
	const noteBlock = `[Nested delegation notes]\n${notes.map((note) => `- ${note}`).join("\n")}`;
	return output ? `${output}\n\n${noteBlock}` : noteBlock;
}

export function getResultOutput(result: SingleResult): string {
	const output = appendOutputNotes(getFinalOutput(result.messages), result.outputNotes);
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || output || "(no output)";
	}
	return output || "(no output)";
}

/**
 * Why a result failed, for the collapsed views. A spawn failure (unknown agent, bad model id,
 * unsupported thinking level) only sets `stderr`, so rendering `errorMessage` alone leaves the
 * user staring at "(no output)" with no idea what went wrong.
 */
export function getFailureText(result: SingleResult): string | undefined {
	if (!isFailedResult(result)) return undefined;
	const text = result.errorMessage || result.stderr?.trim();
	return text ? text.split("\n").slice(0, 3).join("\n") : undefined;
}

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
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

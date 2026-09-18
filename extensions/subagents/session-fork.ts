import * as fs from "node:fs";

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
export function sanitizeSessionForFork(sourceFile: string, destFile: string): number {
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

/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentDepth } from "./depth.ts";
import { registerSubagentTool } from "./dispatch.ts";
import { readNestedRuntime } from "./nested-runtime.ts";
import { startOwnerGuard } from "./process-tree.ts";
import { toolResultMetadata } from "./results.ts";
import { asyncRuns, abortAllAsyncRuns, clearRetainedRuns, sweepStaleTempDirs } from "./runs.ts";
import { registerContactSupervisorTool, SUPERVISOR_TOOL } from "./supervisor.ts";

export default function (pi: ExtensionAPI) {
	const ownerGuard = startOwnerGuard();
	// execute() cannot set AgentToolResult.isError because that field does not exist in Pi's API.
	// Bridge our private details marker onto the mutable tool_result event instead.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent" && event.toolName !== SUPERVISOR_TOOL) return;
		if (toolResultMetadata(event.details)?.failed) return { isError: true };
	});

	// Depth decides which direction the tool points; the envelope only decides whether a depth-1
	// child may also point downward. A depth-2 process never reads the envelope at all, so a
	// forged one cannot manufacture a third level.
	const register = (ctx: ExtensionContext) => {
		const depth = currentDepth();
		if (depth > 0) registerContactSupervisorTool(pi);
		if (depth === 0) {
			registerSubagentTool(pi, ctx);
			return;
		}
		if (depth > 1) return;
		const runtime = readNestedRuntime();
		if (runtime && runtime.allowedAgents.length > 0) registerSubagentTool(pi, ctx, runtime);
	};
	// The model enum is baked into the tool schema, so rebuild it whenever the catalogue behind it
	// can change: session start (also fires for /new, /resume and /fork) and model selection.
	pi.on("session_start", (_event, ctx) => {
		sweepStaleTempDirs();
		register(ctx);
	});
	pi.on("model_select", (_event, ctx) => register(ctx));

	// Detached children are separate processes: without this they survive /new, /resume, /fork and
	// exit, still burning tokens against a session nobody is watching any more.
	pi.on("session_shutdown", (_event, ctx) => {
		ownerGuard?.dispose();
		const stopped = abortAllAsyncRuns();
		if (stopped > 0 && ctx.hasUI) {
			ctx.ui.notify(`Stopped ${stopped} detached subagent run${stopped === 1 ? "" : "s"}.`, "info");
		}
		// A killed child has up to SIGKILL_GRACE_MS left and is still writing its session into the
		// retention root. Deleting it out from under a dying process only manufactures errors.
		// Synchronously, and only synchronously. The retention root is keyed on the process id, not
		// the session, and session_shutdown also fires for /new, /resume and /fork — so a delayed
		// sweep would delete the *next* session's root while its children were writing into it.
		// Whatever a dying child still writes lands in a directory that is already gone, which is
		// harmless; outliving the sweep and corrupting a live session is not.
		clearRetainedRuns();
		asyncRuns.clear();
	});
}

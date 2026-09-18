import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSource } from "./agents.ts";
import { formatUsageStats } from "./format.ts";
import { getResultOutput, type SingleResult } from "./results.ts";
import type { ForkContext } from "./settings.ts";

/**
 * Every piece of mutable module state in this extension lives here.
 *
 * Two things this relies on. ES modules are singletons per process, so one importer or ten see the
 * same maps. And `retentionRoot` is computed once at module load from the pid of the process that
 * loaded it — moving that computation between files does not change when it runs, but making it
 * lazy would change which directory an already-started run writes into.
 *
 * A consequence: an ordinary dynamic `import()` of this module by its own URL returns the same
 * cached module and its existing maps — it does not reset state. What does produce a fresh module
 * graph is Pi's jiti-based reload: the extension loader creates jiti with `moduleCache: false`, so
 * each `jiti.import()` re-evaluates the module instead of reusing a cached instance. No current
 * test relies on either.
 */

/**
 * Retained child sessions for this parent session. A reviewer that finds a fault is only useful
 * if the agent that wrote the code can be handed that finding — which needs its session back,
 * not a fresh child re-derived from a task description.
 */
export const retentionRoot = path.join(os.tmpdir(), `pi-subagent-runs-${process.pid}`);

export interface RetainedRun {
	id: string;
	agent: string;
	agentSource: AgentSource;
	agentFilePath: string;
	/** Package provenance, carried alongside agentSource so a resumed run can still be judged
	 * repo-controlled — or re-saved as one across further resumes — after its live discovery entry
	 * is gone. */
	agentPackageScope?: "user" | "project";
	agentPackageRoot?: string;
	agentPackageName?: string;
	/** The resolved launch contract. A resumed child keeps it rather than re-deriving it. */
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	inheritSkills: boolean;
	inheritProjectContext: boolean;
	defaultContext?: ForkContext;
	systemPrompt: string;
	cwd: string;
	runDir: string;
	sessionFile?: string;
	resumable: boolean;
}

export const retainedRuns = new Map<string, RetainedRun>();

/** pi names the session itself, so find it rather than assuming a path. */
export function findSessionFile(runDir: string): string | undefined {
	const stack = [runDir];
	let newest: { file: string; mtime: number } | undefined;
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.name.endsWith(".jsonl")) {
				try {
					const mtime = fs.statSync(full).mtimeMs;
					if (!newest || mtime > newest.mtime) newest = { file: full, mtime };
				} catch {
					// Vanished between readdir and stat; not a reason to discard a finished run.
				}
			}
		}
	}
	return newest?.file;
}

const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000;

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists and belongs to someone else, which still counts as alive.
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/**
 * Remove scratch directories left by earlier runs.
 *
 * Every temp directory here is cleaned in a `finally`, which does not run when the process is
 * killed outright — an aborted session, a crash, a machine going down mid-dispatch. Each orphan
 * is small, but they accumulate in /tmp forever. Only sweep what is old enough that it cannot
 * belong to a session still running.
 */
export function sweepStaleTempDirs(): void {
	const cutoff = Date.now() - STALE_TEMP_AGE_MS;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith("pi-subagent-")) continue;
		// A retention root's mtime only moves when a dispatch adds a directory, so a long quiet
		// session would look stale; never sweep one whose owning process is still alive.
		const owner = /^pi-subagent-runs-(\d+)$/.exec(entry.name)?.[1];
		if (owner && isProcessAlive(Number(owner))) continue;
		const full = path.join(os.tmpdir(), entry.name);
		try {
			if (fs.statSync(full).mtimeMs > cutoff) continue;
			fs.rmSync(full, { recursive: true, force: true });
		} catch {
			// Another session's directory, or one being removed right now; leave it alone.
		}
	}
}

export function newRunId(): string {
	return randomUUID().slice(0, 8);
}

export function clearRetainedRuns(): void {
	retainedRuns.clear();
	try {
		fs.rmSync(retentionRoot, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

export type AsyncRunState = "running" | "complete" | "failed" | "stopped";

export interface AsyncRun {
	id: string;
	agent: string;
	task: string;
	state: AsyncRunState;
	startedAt: number;
	finishedAt?: number;
	controller: AbortController;
	result?: SingleResult;
	error?: string;
}

/**
 * Detached runs for this session. Module state, which lives as long as the extension does, so a
 * run started in one tool call is still addressable from the next.
 */
export const asyncRuns = new Map<string, AsyncRun>();

/**
 * Run ids with a live child, detached or not.
 *
 * `asyncRuns` state flips to "stopped" the moment abort is requested, but the child still has
 * SIGKILL_GRACE_MS to exit and is still flushing its transcript. Resuming against that file would
 * put a second pi on it. Synchronous runs never enter `asyncRuns` at all, so they need the same
 * bookkeeping.
 */
export const runsInFlight = new Set<string>();

const LISTED_RUN_CHARS = 800;

export function truncateForListing(text: string): string {
	return text.length <= LISTED_RUN_CHARS ? text : `${text.slice(0, LISTED_RUN_CHARS)}…\n  (ask for this run by id for the rest)`;
}

export function describeAsyncRun(run: AsyncRun): string {
	const seconds = Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000);
	const usage = run.result ? formatUsageStats(run.result.usage, run.result.model) : "";
	const head = `${run.id}  ${run.state}  ${run.agent}  ${seconds}s${usage ? `  ${usage}` : ""}`;
	const task = run.task.length > 80 ? `${run.task.slice(0, 80)}…` : run.task;
	if (run.state === "running") return `${head}\n  task: ${task}`;
	const body = run.error ?? (run.result ? getResultOutput(run.result) : "(no output)");
	return `${head}\n  task: ${task}\n  ${body.split("\n").join("\n  ")}`;
}

/** Stop every live run. Children are separate processes and outlive the session otherwise. */
export function abortAllAsyncRuns(): number {
	let stopped = 0;
	for (const run of asyncRuns.values()) {
		if (run.state !== "running") continue;
		run.controller.abort();
		run.state = "stopped";
		run.finishedAt = Date.now();
		stopped++;
	}
	return stopped;
}

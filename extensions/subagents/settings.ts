import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS } from "./models.ts";

export const DEFAULT_MAX_PARALLEL_TASKS = 8;
export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_MAX_NESTED_SPAWNS = 4;
export const DEFAULT_MAX_NESTED_CONCURRENCY = 2;
export const MAX_NESTED_SPAWNS = 16;
export const MAX_NESTED_CONCURRENCY = 8;

export type ForkContext = "fresh" | "fork";

/** A parallel fan-out limit: a positive integer, or an explicit opt-out of the cap. */
export type FanOutLimit = number | "unbounded";

export interface SubagentSettings {
	defaultThinking?: ThinkingLevel;
	maxThinking?: ThinkingLevel;
	defaultContext?: ForkContext;
	/** Admission limit for one parallel call. Always resolved, defaulting to DEFAULT_MAX_PARALLEL_TASKS. */
	maxParallelTasks: FanOutLimit;
	/** Children alive at once within one parallel call. Always resolved, defaulting to DEFAULT_MAX_CONCURRENCY. */
	maxConcurrency: FanOutLimit;
	/** Total grandchildren one coordinator may start over its whole life. 0 disables nesting. */
	maxNestedSpawns: number;
	/** Grandchildren alive at once within one coordinator. */
	maxNestedConcurrency: number;
}

/**
 * Anything that is not a positive integer or `"unbounded"` is ignored, so a typo in settings
 * falls back to the default rather than silently uncapping or crippling dispatch.
 */
export function parseFanOutLimit(value: unknown): FanOutLimit | undefined {
	if (value === "unbounded") return "unbounded";
	if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
	return undefined;
}

export function fanOutRank(limit: FanOutLimit): number {
	return limit === "unbounded" ? Number.POSITIVE_INFINITY : limit;
}

/**
 * A hard process cap, unlike FanOutLimit: there is no "unbounded" spelling, because a machine
 * running a tree of processes is exactly what these two numbers exist to bound.
 */
export function parseBoundedInt(value: unknown, min: number, max: number): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
	return value >= min && value <= max ? value : undefined;
}

/**
 * Only the operator's own settings may raise a limit; a trusted project may lower one and nothing
 * more. Shared by every limit family so the rule has one definition to audit.
 */
export function resolveLowerableLimit<T>(
	userValue: unknown,
	projectValue: unknown,
	fallback: T,
	parse: (value: unknown) => T | undefined,
	rank: (limit: T) => number,
): T {
	const effective = parse(userValue) ?? fallback;
	const project = parse(projectValue);
	return project !== undefined && rank(project) < rank(effective) ? project : effective;
}

/**
 * Only the operator's own settings may raise a limit. A repository is not an authorization
 * boundary for how many processes the machine runs, so a trusted project may lower one and
 * nothing more: a checkout that could raise it would be a fan-out amplifier for anything that
 * reaches the dispatching model, and prompt injection reaches it through the files it reads.
 */
export function resolveFanOutLimit(userValue: unknown, projectValue: unknown, fallback: number): FanOutLimit {
	return resolveLowerableLimit<FanOutLimit>(userValue, projectValue, fallback, parseFanOutLimit, fanOutRank);
}

function readSettingsFile(file: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** Walk up for the project settings file, the way project agents are already discovered. */
export function findProjectSettings(cwd: string): string | undefined {
	let dir = path.resolve(cwd);
	for (;;) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, "settings.json");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function canonicalPath(value: string): string {
	try {
		return fs.realpathSync(value);
	} catch {
		return path.resolve(value);
	}
}

function isWithinProject(cwd: string, root: string): boolean {
	const relative = path.relative(canonicalPath(root), canonicalPath(cwd));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function trustedProjectSettings(cwd: string): { file: string; root: string } | undefined {
	const file = findProjectSettings(cwd);
	return file ? { file, root: path.dirname(path.dirname(file)) } : undefined;
}

/** `subagents` settings, project overriding user only after Pi approved that project. */
export function readSubagentSettings(
	cwd: string,
	trustedProject: { file: string; root: string } | undefined,
): SubagentSettings {
	const readSubagents = (file: string) => readSettingsFile(file)?.subagents as Record<string, unknown> | undefined;
	const userRaw = readSubagents(path.join(getAgentDir(), "settings.json"));
	const projectRaw =
		trustedProject && isWithinProject(cwd, trustedProject.root) ? readSubagents(trustedProject.file) : undefined;
	const merged: SubagentSettings = {
		maxParallelTasks: resolveFanOutLimit(
			userRaw?.maxParallelTasks,
			projectRaw?.maxParallelTasks,
			DEFAULT_MAX_PARALLEL_TASKS,
		),
		maxConcurrency: resolveFanOutLimit(userRaw?.maxConcurrency, projectRaw?.maxConcurrency, DEFAULT_MAX_CONCURRENCY),
		maxNestedSpawns: resolveLowerableLimit(
			userRaw?.maxNestedSpawns,
			projectRaw?.maxNestedSpawns,
			DEFAULT_MAX_NESTED_SPAWNS,
			(value) => parseBoundedInt(value, 0, MAX_NESTED_SPAWNS),
			(limit) => limit,
		),
		maxNestedConcurrency: resolveLowerableLimit(
			userRaw?.maxNestedConcurrency,
			projectRaw?.maxNestedConcurrency,
			DEFAULT_MAX_NESTED_CONCURRENCY,
			(value) => parseBoundedInt(value, 1, MAX_NESTED_CONCURRENCY),
			(limit) => limit,
		),
	};
	for (const raw of [userRaw, projectRaw]) {
		if (!raw) continue;
		for (const key of ["defaultThinking", "maxThinking"] as const) {
			const value = raw[key];
			if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
				merged[key] = value as ThinkingLevel;
			}
		}
		if (raw.defaultContext === "fork" || raw.defaultContext === "fresh") {
			merged.defaultContext = raw.defaultContext;
		}
	}
	return merged;
}

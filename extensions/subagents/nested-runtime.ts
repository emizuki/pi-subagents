/**
 * The contract a root process hands a coordinator, and the only thing that distinguishes a
 * coordinator from an ordinary child at depth 1.
 *
 * The environment is not a trust boundary against a process that already controls the tree: a
 * well-formed forged envelope grants delegation, and no design that passes authority through
 * `spawn` can prevent that. What this module guarantees is that it fails closed on absence and
 * on corruption, and that depth 2 never consults it at all.
 */

import { MAX_NESTED_CONCURRENCY, MAX_NESTED_SPAWNS, parseBoundedInt } from "./settings.ts";
import type { AgentConfig } from "./agents.ts";
import { type ModelLike, modelKey } from "./models.ts";

export const RUNTIME_ENV_VAR = "PI_SUBAGENT_RUNTIME_V1";
/** Task 4 uses this variable for the parent-process ownership guard. */
export const OWNER_PID_ENV_VAR = "PI_SUBAGENT_OWNER_PID";

export interface NestedRuntimeV1 {
	version: 1;
	/** Always 1. Recorded for validation only; PI_SUBAGENT_DEPTH decides actual depth. */
	depth: 1;
	agent: string;
	/** Canonical agent names the root resolved and approved. Empty means no delegation. */
	allowedAgents: string[];
	/** The coordinator's own tool allowlist, or null when it declared none. */
	toolCeiling: string[] | null;
	/** The root's model scope as model keys, or null when the root was unscoped. */
	modelCeiling: string[] | null;
	budget: { maxSpawns: number; maxConcurrency: number };
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isNullableStringArray(value: unknown): value is string[] | null {
	return value === null || isStringArray(value);
}

export function encodeNestedRuntime(runtime: NestedRuntimeV1): string {
	return JSON.stringify(runtime);
}

/**
 * Returns undefined for anything malformed and never salvages part of an envelope. A partially
 * trusted contract is the failure mode this whole design exists to avoid.
 */
export function parseNestedRuntime(raw: string | undefined): NestedRuntimeV1 | undefined {
	if (!raw) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== 1 || candidate.depth !== 1) return undefined;
	if (typeof candidate.agent !== "string" || candidate.agent.length === 0) return undefined;
	if (!isStringArray(candidate.allowedAgents)) return undefined;
	if (!isNullableStringArray(candidate.toolCeiling)) return undefined;
	if (!isNullableStringArray(candidate.modelCeiling)) return undefined;
	const budget = candidate.budget;
	if (typeof budget !== "object" || budget === null || Array.isArray(budget)) return undefined;
	const { maxSpawns, maxConcurrency } = budget as Record<string, unknown>;
	const parsedMaxSpawns = parseBoundedInt(maxSpawns, 0, MAX_NESTED_SPAWNS);
	const parsedMaxConcurrency = parseBoundedInt(maxConcurrency, 1, MAX_NESTED_CONCURRENCY);
	if (parsedMaxSpawns === undefined || parsedMaxConcurrency === undefined) return undefined;
	return {
		version: 1,
		depth: 1,
		agent: candidate.agent,
		allowedAgents: candidate.allowedAgents,
		toolCeiling: candidate.toolCeiling,
		modelCeiling: candidate.modelCeiling,
		budget: { maxSpawns: parsedMaxSpawns, maxConcurrency: parsedMaxConcurrency },
	};
}

export function readNestedRuntime(): NestedRuntimeV1 | undefined {
	return parseNestedRuntime(process.env[RUNTIME_ENV_VAR]);
}

/** Injected by the extension rather than declared in frontmatter, so never part of a comparison. */
const INTERNAL_TOOLS = new Set(["subagent", "contact_supervisor"]);

/**
 * Whether a child's declared tools stay inside the coordinator's own allowlist.
 *
 * An omitted child list is Pi's full default set, including edit and write, which is broader than
 * any restricted coordinator — so omission is refused rather than treated as "inherits the parent".
 * An omitted coordinator list is itself unrestricted, and an unrestricted agent coordinating an
 * unrestricted child gains nothing it did not already hold.
 */
export function withinToolCeiling(coordinatorTools: string[] | undefined, childTools: string[] | undefined): boolean {
	if (coordinatorTools === undefined) return true;
	if (childTools === undefined) return false;
	const ceiling = new Set(coordinatorTools.filter((tool) => !INTERNAL_TOOLS.has(tool)));
	return childTools.every((tool) => INTERNAL_TOOLS.has(tool) || ceiling.has(tool));
}

function matchAgents(agents: AgentConfig[], wanted: string): AgentConfig[] {
	const needle = wanted.trim().toLowerCase();
	if (!needle) return [];
	const byName = agents.filter((a) => a.name.toLowerCase() === needle);
	if (byName.length > 0) return byName;
	return agents.filter((a) => a.aliases.some((alias) => alias.toLowerCase() === needle));
}

/**
 * Turn a coordinator's declared `allowedSubagents` into the canonical names the root is willing to
 * authorize. The caller must check `allowNestedSubagents` before using this result; this function
 * only resolves and filters the declared candidates. Every rejection is reported rather than
 * silently swallowed, because this runs for an agent that ships enabled by default and a silent
 * empty result looks identical to a bug.
 */
export function resolveAllowedAgents(
	coordinator: AgentConfig,
	agents: AgentConfig[],
): { allowed: string[]; dropped: Array<{ name: string; reason: string }> } {
	const allowed: string[] = [];
	const dropped: Array<{ name: string; reason: string }> = [];
	const seen = new Set<string>();
	for (const wanted of coordinator.allowedSubagents) {
		const matches = matchAgents(agents, wanted);
		if (matches.length === 0) {
			dropped.push({ name: wanted, reason: "not found in the user scope" });
			continue;
		}
		if (matches.length > 1) {
			dropped.push({ name: wanted, reason: "ambiguous: matches more than one agent" });
			continue;
		}
		const child = matches[0];
		// Identity, not spelling: an alias of the coordinator is still the coordinator.
		if (child.filePath === coordinator.filePath || child.name === coordinator.name) {
			dropped.push({ name: wanted, reason: "an agent may not delegate to itself" });
			continue;
		}
		if (!withinToolCeiling(coordinator.tools, child.tools)) {
			dropped.push({ name: wanted, reason: "its tools exceed the coordinator's own" });
			continue;
		}
		if (seen.has(child.name)) continue;
		seen.add(child.name);
		allowed.push(child.name);
	}
	return { allowed, dropped };
}

/**
 * `null` means the root was unscoped and everything local stays selectable. An empty array means
 * nothing is selectable, and is never read as "unrestricted" — that conflation is exactly how a
 * model ceiling turns into no ceiling.
 */
export function intersectModelCeiling(choices: ModelLike[], ceiling: string[] | null): ModelLike[] {
	if (ceiling === null) return choices;
	const permitted = new Set(ceiling.map((key) => key.toLowerCase()));
	return choices.filter((choice) => permitted.has(modelKey(choice).toLowerCase()));
}

/**
 * Whether a coordinator may register `subagent` at all, given what its model ceiling leaves it.
 *
 * `null` is unrestricted and always passes. A non-empty ceiling that intersects to nothing must
 * fail closed: `modelSchema` falls back to a free-form `Type.String` when handed no choices, and
 * `runSingleAgent`'s execution-time check guards on `scopedModels?.length` — falsy for `[]` — so an
 * empty intersection would remove both layers at once and read as unrestricted.
 */
export function nestedRegistrationAllowed(args: { localChoices: ModelLike[]; ceiling: string[] | null }): boolean {
	return intersectModelCeiling(args.localChoices, args.ceiling).length > 0;
}

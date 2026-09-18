/**
 * The contract a root process hands a coordinator, and the only thing that distinguishes a
 * coordinator from an ordinary child at depth 1.
 *
 * The environment is not a trust boundary against a process that already controls the tree: a
 * well-formed forged envelope grants delegation, and no design that passes authority through
 * `spawn` can prevent that. What this module guarantees is that it fails closed on absence and
 * on corruption, and that depth 2 never consults it at all.
 */

export const RUNTIME_ENV_VAR = "PI_SUBAGENT_RUNTIME_V1";
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

function isBoundedInt(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
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
	if (!isBoundedInt(maxSpawns, 0, 16) || !isBoundedInt(maxConcurrency, 1, 8)) return undefined;
	return {
		version: 1,
		depth: 1,
		agent: candidate.agent,
		allowedAgents: candidate.allowedAgents,
		toolCeiling: candidate.toolCeiling,
		modelCeiling: candidate.modelCeiling,
		budget: { maxSpawns, maxConcurrency },
	};
}

export function readNestedRuntime(): NestedRuntimeV1 | undefined {
	return parseNestedRuntime(process.env[RUNTIME_ENV_VAR]);
}

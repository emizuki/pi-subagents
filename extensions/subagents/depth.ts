/**
 * The child inherits this process's environment, so it also loads this extension and can call
 * the tool again. Depth is therefore the one fact a child cannot talk itself out of: registration
 * keys on it exactly, and the runtime envelope may only narrow authority within depth 1.
 */
export const DEPTH_ENV_VAR = "PI_SUBAGENT_DEPTH";

export function currentDepth(): number {
	const raw = Number.parseInt(process.env[DEPTH_ENV_VAR] ?? "0", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

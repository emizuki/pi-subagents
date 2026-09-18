/**
 * The child inherits this process's environment, so it also loads this extension and can call
 * the tool again. One level of delegation is useful; a tree of them multiplies cost silently.
 */
export const DEPTH_ENV_VAR = "PI_SUBAGENT_DEPTH";

export const MAX_SUBAGENT_DEPTH = 1;

export function currentDepth(): number {
	const raw = Number.parseInt(process.env[DEPTH_ENV_VAR] ?? "0", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

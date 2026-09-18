import { StringEnum } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * `--model` accepts an optional `:<thinking>` suffix (e.g. `sonnet:high`). Only split it off when
 * the tail is a real thinking level, so model ids that legitimately contain a colon (`llama3:8b`)
 * survive untouched.
 */
export function splitThinkingSuffix(spec: string): { model: string; thinking?: ThinkingLevel } {
	const i = spec.lastIndexOf(":");
	if (i === -1) return { model: spec };
	const tail = spec.slice(i + 1);
	return (THINKING_LEVELS as readonly string[]).includes(tail)
		? { model: spec.slice(0, i), thinking: tail as ThinkingLevel }
		: { model: spec };
}

/**
 * Structural view of a model entry. `thinkingLevelMap` is documented for models.json but is not
 * part of the documented extension surface, so treat it as optional and degrade gracefully.
 */
export interface ModelLike {
	provider: string;
	id: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	cost?: { input: number };
}

/**
 * Thinking levels a model actually accepts. Per pi-models.md: a missing key means the level works
 * through `high` but leaves `xhigh`/`max` unsupported; an explicit `null` means unsupported.
 */
export function supportedThinking(model: ModelLike): ThinkingLevel[] {
	if (model.reasoning === false) return ["off"];
	const map = model.thinkingLevelMap;
	return THINKING_LEVELS.filter((level) => {
		const mapped = map?.[level];
		if (mapped === null) return false;
		if (mapped === undefined) return level !== "xhigh" && level !== "max";
		return true;
	});
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Index into THINKING_LEVELS, which is ordered least to most thinking. */
export function thinkingRank(level: ThinkingLevel): number {
	return THINKING_LEVELS.indexOf(level);
}

export function modelKey(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

/** Split `provider/id` on the FIRST slash: ids themselves may contain slashes. */
export function splitModelKey(key: string): { provider: string; id: string } | undefined {
	const i = key.indexOf("/");
	return i === -1 ? undefined : { provider: key.slice(0, i), id: key.slice(i + 1) };
}

export function normalizeModelReference(spec: string): string {
	const trimmed = spec.trim();
	const slash = trimmed.indexOf("/");
	if (slash === -1) return trimmed.toLowerCase();
	return `${trimmed.slice(0, slash).trim()}/${trimmed.slice(slash + 1).trim()}`.toLowerCase();
}

export function findScopedModel(
	scopedModels: Array<{ model: ModelLike; thinkingLevel?: ThinkingLevel }> | undefined,
	spec: string,
): { model: ModelLike; thinkingLevel?: ThinkingLevel } | undefined {
	if (!scopedModels?.length) return undefined;
	const normalized = normalizeModelReference(spec);
	const exact = scopedModels.find((entry) => normalizeModelReference(modelKey(entry.model)) === normalized);
	if (exact) return exact;
	const byId = scopedModels.filter((entry) => entry.model.id.toLowerCase() === normalized);
	return byId.length === 1 ? byId[0] : undefined;
}

/** Models offered to the LLM, honoring the current session scope when one is configured. */
export function modelChoices(ctx: ExtensionContext): ModelLike[] {
	const pool =
		ctx.scopedModels.length > 0
			? ctx.scopedModels.map(({ model }) => model)
			: ctx.modelRegistry.getAvailable();
	const seen = new Set<string>();
	const unique = pool.filter((m) => !seen.has(modelKey(m)) && seen.add(modelKey(m)));
	// Cheapest first, unpriced last: the order is the only pricing signal the model gets, and
	// naming one model in a guideline would pin it to a choice its account may not even allow.
	return unique.sort((a, b) => (a.cost?.input ?? Number.POSITIVE_INFINITY) - (b.cost?.input ?? Number.POSITIVE_INFINITY));
}

export function modelSchema(choices: ModelLike[], current: string | undefined) {
	const description = `Model for the subagent, ordered cheapest first. Omit to inherit the dispatching session's model${
		current ? ` (${current})` : ""
	}.`;
	const keys = choices.map(modelKey);
	// StringEnum needs a non-empty list; with nothing to choose from, accept a free-form id.
	return keys.length > 0
		? StringEnum(keys as [string, ...string[]], { description })
		: Type.String({ description });
}

/**
 * Thinking levels are per-model, but the model is picked in the same call, so the schema can only
 * offer the union across the offered models. `runSingleAgent` rejects a pair the resolved model
 * does not actually accept.
 */
export function thinkingSchema(choices: ModelLike[]) {
	const union = THINKING_LEVELS.filter((level) => choices.some((m) => supportedThinking(m).includes(level)));
	const levels = union.length > 0 ? union : THINKING_LEVELS;
	return StringEnum(levels as unknown as [ThinkingLevel, ...ThinkingLevel[]], {
		description:
			"Thinking level for the subagent. Overrides a level pinned on the agent's model. Not every model accepts every level.",
	});
}

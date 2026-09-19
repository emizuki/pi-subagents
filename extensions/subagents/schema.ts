import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentConfig } from "./agents.ts";
import { type ModelLike, modelSchema, thinkingSchema } from "./models.ts";

export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

/**
 * Without a nudge the model leaves `model` unset, because omitting it is the documented default.
 * Name the cheapest offered model explicitly so mechanical work has somewhere obvious to go.
 * Guidelines are appended flat to the prompt with no tool prefix, so each one names the tool.
 */
export function buildGuidelines(choices: ModelLike[], currentModel: ModelLike | undefined, agents: AgentConfig[]): string[] {
	const guidelines: string[] = [];

	// Steering the agent choice matters more than the model: a full-tool agent on a read-only
	// task costs more and can write files the task never asked it to touch.
	const restricted = agents.filter(
		(a) => a.suggest && a.tools?.length && !a.tools.some((t) => t === "write" || t === "edit"),
	);
	if (restricted.length > 0 && agents.length > restricted.length) {
		const names = restricted.map((a) => `"${a.name}"`).join(" or ");
		guidelines.push(
			`Prefer an available specialist when its description directly matches the task. Otherwise, call the subagent tool with agent: ${names} for neutral read-only investigation — searching, listing, reading or summarising. Reserve the full-tool agents for work that must actually change something.`,
		);
	}

	// Deliberately nameless, and deliberately without a price ratio: both pin the caller to one
	// model. Catalogue prices are list prices anyway, which a subscription account may not pay.
	// Zero is a valid price for local and free models; only missing prices are unknown.
	const cheapest = choices.find((m) => m.cost?.input !== undefined);
	if (
		cheapest?.cost?.input !== undefined &&
		currentModel?.cost?.input !== undefined &&
		cheapest.cost.input < currentModel.cost.input
	) {
		guidelines.push(
			"For that read-only work, also pass a cheaper model to the subagent tool: its model parameter lists models cheapest first.",
			"Leave the subagent tool's model unset for work that needs judgement, such as planning, review or writing code; it then inherits the session's model.",
		);
	}

	return guidelines;
}

export function makeSubagentParams(choices: ModelLike[], current: string | undefined) {
	const model = Type.Optional(modelSchema(choices, current));
	const thinking = Type.Optional(thinkingSchema(choices));
	const context = Type.Optional(
		StringEnum(["fresh", "fork"] as const, {
			description:
				'Child context. "fresh" (default) starts from the task alone; "fork" branches this session\'s transcript, which costs its input tokens on every turn.',
		}),
	);

	const TaskItem = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task to delegate to the agent" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		model,
		thinking,
		context,
	});

	const ChainItem = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		model,
		thinking,
		context,
	});

	return Type.Object({
		agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
		task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
		tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
		chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
		agentScope: Type.Optional(AgentScopeSchema),
		confirmProjectAgents: Type.Optional(
			Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
		),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
		model,
		thinking,
		context,
		async: Type.Optional(
			Type.Boolean({
				description:
					"Single mode only: start the run detached and return a run id immediately, instead of waiting for it.",
			}),
		),
		action: Type.Optional(
			StringEnum(["status", "stop", "runs"] as const, {
				description:
					'Inspect detached runs ("status", optionally with id), end one ("stop", with id), or list resumable runs ("runs").',
			}),
		),
		resume: Type.Optional(
			Type.String({
				description:
					"Run id to revive instead of starting a new child, with task as the follow-up. Mutually exclusive with agent; the revived child keeps its original agent, model and tools.",
			}),
		),
		id: Type.Optional(Type.String({ description: "Run id, for status or stop" })),
	});
}

/**
 * The coordinator's parameter set: synchronous single and parallel, nothing else.
 *
 * The modes a coordinator must not use are absent rather than rejected. A model that cannot
 * express a request needs no error path for it, and removing `cwd` bounds a grandchild to the
 * coordinator's working directory with no code at all.
 */
export function makeNestedSubagentParams(choices: ModelLike[], current: string | undefined) {
	const model = Type.Optional(modelSchema(choices, current));
	const thinking = Type.Optional(thinkingSchema(choices));
	const context = Type.Optional(
		StringEnum(["fresh", "fork"] as const, {
			description: 'Child context. "fresh" (default) starts from the task alone; "fork" branches this session\'s transcript.',
		}),
	);

	const TaskItem = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task to delegate to the agent" }),
		model,
		thinking,
		context,
	});

	return Type.Object({
		agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
		task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
		tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} to run in parallel" })),
		model,
		thinking,
		context,
	});
}

/**
 * The keys of `wide.properties` that `narrow.properties` omits. Shared by both derived sets below
 * so a top-level comparison and a per-task-item comparison can never be computed two different
 * ways. Typed structurally rather than against the builders' own TypeBox return types: only
 * `.properties` and its key names are read here, never a value's shape.
 */
function forbiddenKeys(
	wide: { properties: Record<string, unknown> },
	narrow: { properties: Record<string, unknown> },
): string[] {
	return Object.keys(wide.properties).filter((key) => !(key in narrow.properties));
}

// `[]` and `undefined` are enough for both calls: only property *names* are read below, and
// neither builder's key set — top level or per task item — depends on `choices` or `current`.
const wideParams = makeSubagentParams([], undefined);
const narrowParams = makeNestedSubagentParams([], undefined);

/**
 * Keys the wide, coordinator-facing root schema declares at the top level that the nested schema
 * omits — the complete set a nested call must never carry outside `tasks[]`. Derived from the two
 * schemas themselves rather than hand-copied: a key added to `makeSubagentParams` alone (a future
 * `timeout`, `env`) joins this set automatically, with no second list to remember to update and no
 * window where it is silently reachable from a coordinator.
 *
 * This reads only the two objects' own `.properties` — a key added solely inside `TaskItem` (a
 * future `sandboxRoot` on a per-task position, say) does not appear here no matter how closely its
 * name reads like a top-level control. NESTED_FORBIDDEN_TASK_KEYS below is the same comparison one
 * level down, for exactly that case; the two sets are independent derivations, not one covering
 * the other by accident.
 */
export const NESTED_FORBIDDEN_KEYS: string[] = forbiddenKeys(wideParams, narrowParams);

/**
 * The same comparison, one level down: keys the wide `TaskItem` declares that the nested
 * `TaskItem` omits. `cwd` is the only member today, and it is caught here independently of
 * NESTED_FORBIDDEN_KEYS finding it too at the top level — remove `cwd` from the wide schema's top
 * level alone (leaving it on `TaskItem`) and this set still flags it on every task, because this
 * derivation never consulted the top-level one to begin with.
 */
export const NESTED_FORBIDDEN_TASK_KEYS: string[] = forbiddenKeys(wideParams.properties.tasks.items, narrowParams.properties.tasks.items);

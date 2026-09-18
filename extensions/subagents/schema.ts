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

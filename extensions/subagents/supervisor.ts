import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { finalizeToolResult } from "./results.ts";

/** Directory the child writes supervisor requests into and reads replies from. */
export const IPC_ENV_VAR = "PI_SUBAGENT_IPC_DIR";
/** A supervisor request waits on a human, so the ceiling is generous; it exists to avoid a hang. */
export const SUPERVISOR_TIMEOUT_MS = 10 * 60_000;
export const SUPERVISOR_POLL_MS = 250;
export const SUPERVISOR_TOOL = "contact_supervisor";
export const SUPERVISOR_REASONS = ["need_decision", "interview_request", "progress_update"] as const;
export type SupervisorReason = (typeof SUPERVISOR_REASONS)[number];

export interface SupervisorRequest {
	id: string;
	reason: SupervisorReason;
	message: string;
	agent: string;
}

export type SupervisorHandler = (request: SupervisorRequest) => Promise<string>;

/**
 * Parent-facing half: answer any requests the child has written, once.
 *
 * Replies are staged then renamed for the same reason requests are: the child polls for the file
 * and must not parse a partial one.
 */
export async function drainSupervisorRequests(dir: string, handle: SupervisorHandler): Promise<void> {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".req.json")) continue;
		const requestPath = path.join(dir, entry);
		let request: SupervisorRequest;
		try {
			request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
		} catch {
			continue;
		}
		// Claim it before awaiting, so a slow answer is not handed out twice by the next poll.
		try {
			fs.renameSync(requestPath, `${requestPath}.claimed`);
		} catch {
			continue;
		}
		let answer: string;
		try {
			answer = await handle(request);
		} catch {
			// A cancelled prompt still has to release the child: the request is already claimed and
			// can never be handed out again, so saying nothing leaves it blocked until its deadline.
			answer = "No answer from the operator. Proceed on your own judgement and state the assumption you made.";
		}
		if (request.reason === "progress_update") continue;
		const replyPath = path.join(dir, `${request.id}.res.json`);
		try {
			fs.writeFileSync(`${replyPath}.partial`, JSON.stringify({ message: answer }), "utf8");
			fs.renameSync(`${replyPath}.partial`, replyPath);
		} catch {
			// The child timed out and its directory is gone; nothing left to answer.
		}
	}
}

/**
 * Child-facing half of the supervisor channel.
 *
 * A child that hits a real decision should be able to ask instead of guessing, and a guess is
 * indistinguishable from an answer once it reaches the parent as prose. Registered only inside a
 * spawned child, which is also the only place the tool could work: it needs the IPC directory the
 * parent created for that run.
 */
export function registerContactSupervisorTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: SUPERVISOR_TOOL,
		label: "Contact supervisor",
		description: [
			"Ask the session that dispatched you, which can reach the operator.",
			"Use need_decision when a choice is genuinely the operator's to make and guessing would be wrong,",
			"interview_request when you need structured input, and progress_update to report a discovery that",
			"changes the plan without waiting for an answer.",
			"Do not ask when instructions merely look restrictive: a no-edit instruction simply wins.",
		].join(" "),
		parameters: Type.Object({
			reason: StringEnum(SUPERVISOR_REASONS, { description: "Why you are contacting the supervisor" }),
			message: Type.String({ description: "The question or update, self-contained: the supervisor has not seen your context" }),
		}),

		async execute(_toolCallId, params, signal) {
			const dir = process.env[IPC_ENV_VAR];
			if (!dir) {
				return finalizeToolResult({
					content: [{ type: "text", text: "No supervisor channel is available. Proceed on your own judgement and say what you assumed." }],
					failed: true,
				});
			}

			const id = randomUUID();
			const request: SupervisorRequest = {
				id,
				reason: params.reason as SupervisorReason,
				message: params.message,
				agent: process.env.PI_SUBAGENT_AGENT ?? "subagent",
			};
			// Write to a temp name first: the parent polls this directory and must never read a
			// half-written request.
			const finalPath = path.join(dir, `${id}.req.json`);
			const stagingPath = `${finalPath}.partial`;
			fs.writeFileSync(stagingPath, JSON.stringify(request), "utf8");
			fs.renameSync(stagingPath, finalPath);

			if (request.reason === "progress_update") {
				return finalizeToolResult({ content: [{ type: "text", text: "Update delivered to the supervisor." }] });
			}

			const replyPath = path.join(dir, `${id}.res.json`);
			const deadline = Date.now() + SUPERVISOR_TIMEOUT_MS;
			while (Date.now() < deadline) {
				if (signal?.aborted) {
					return finalizeToolResult({
						content: [{ type: "text", text: "Aborted while waiting for the supervisor." }],
						failed: true,
					});
				}
				if (fs.existsSync(replyPath)) {
					try {
						const reply = JSON.parse(fs.readFileSync(replyPath, "utf8")) as { message?: string };
						return finalizeToolResult({ content: [{ type: "text", text: reply.message || "(empty reply)" }] });
					} catch {
						// Fall through and retry: the parent may still be writing.
					}
				}
				await new Promise((resolve) => setTimeout(resolve, SUPERVISOR_POLL_MS));
			}
			return finalizeToolResult({
				content: [{ type: "text", text: "The supervisor did not answer in time. Proceed on your own judgement and state the assumption you made." }],
				failed: true,
			});
		},
	});
}

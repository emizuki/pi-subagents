import type { AgentConfig } from "./agents.ts";

/**
 * Resolve an agent by name or alias, case-insensitively. Callers reach for habitual names —
 * "general", "explorer", "Explore" — and an exact-match-only lookup turns that into a failed
 * dispatch instead of the agent the caller obviously meant.
 */
export function findAgent(agents: AgentConfig[], wanted: string): AgentConfig | undefined {
	const needle = wanted.trim().toLowerCase();
	return (
		agents.find((a) => a.name.toLowerCase() === needle) ??
		agents.find((a) => a.aliases.some((alias) => alias.toLowerCase() === needle))
	);
}

export function describeAgent(agent: AgentConfig): string {
	return agent.aliases.length > 0 ? `${agent.name} (aka ${agent.aliases.join(", ")})` : agent.name;
}

/**
 * A repo-controlled agent is one whose definition lives inside the checkout: an explicit project
 * agent file, or a package agent discovered through project-scoped package settings. Either way
 * its `tools:` and prompt come from the repository, not from the user or the package default, so
 * both need the same confirmation gate before dispatch — only where Pi found the file differs.
 *
 * This function has one call site, in the fresh-dispatch confirmation gate below, where the
 * `packageScope === "project"` half of the check cannot currently fire: that gate only runs when
 * `!ctx.isProjectTrusted()`, but `discoverPackageAgentDirectories` only reads project-scoped
 * package settings when `projectTrusted` is true, and there is no `await` between the two checks
 * to let trust change in between — so `agents` can never contain a project-scoped package agent
 * while the gate is live. (Resume, further below, is gated separately by checking
 * `resumeTarget.agentPackageScope` directly, not through this function.) The branch stays here as
 * defence-in-depth against that invariant changing, not because it is exercised today.
 */
export function isRepoControlledAgent(agent: AgentConfig | undefined): agent is AgentConfig {
	return agent?.source === "project" || agent?.packageScope === "project";
}

/**
 * Where to point a caller who is asked to trust a repo-controlled agent. `discovery.projectAgentsDir`
 * only describes the `project` source; it is null for a project-scoped package agent, which would
 * otherwise render as "(unknown)". A package's own root — or its name, if the root is unavailable —
 * is a location the caller can actually go inspect.
 *
 * The `packageRoot`/`packageName` branch is unreachable today for the same reason noted on
 * `isRepoControlledAgent` above — its only caller filters through that function first — and stays
 * for the same defence-in-depth reason.
 */
export function repoControlledSource(agent: AgentConfig, projectAgentsDir: string | null): string {
	if (agent.source === "project") return projectAgentsDir ?? "(unknown)";
	return agent.packageRoot ?? agent.packageName ?? "(unknown package)";
}

/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "builtin" | "package" | "user" | "project";

export interface AgentConfig {
	name: string;
	/** Extra names this agent answers to, so a caller reaching for a habitual name still lands. */
	aliases: string[];
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	/** Let the child discover skills. Off by default: a child reloading the skill catalogue pays
	 * for it on every dispatch, and the task it was given is usually narrower than the catalogue. */
	inheritSkills: boolean;
	/** Let the child load AGENTS.md / CLAUDE.md from its cwd. On by default: repository conventions
	 * are usually exactly what a delegated task needs to respect. */
	inheritProjectContext: boolean;
	/** Preference only: when the parent has no persisted session, a fork preference runs fresh. */
	defaultContext?: "fresh" | "fork";
	/**
	 * Whether to offer this agent in the tool's guidance as a general read-only choice.
	 *
	 * Defaults to true for any agent with a restricted tool list, which is right for a scout and
	 * wrong for a specialist: an agent that expects one finding to score, or a diff to audit, does
	 * nothing useful with "find the auth code" and should say so rather than be recommended for it.
	 */
	suggest: boolean;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	packageName?: string;
	packageRoot?: string;
	packageScope?: "user" | "project";
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	aliases?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
	inheritSkills?: unknown;
	inheritProjectContext?: unknown;
	defaultContext?: unknown;
	suggest?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
function parseToolList(value: unknown): string[] | undefined {
	// Omitted means "use pi's defaults". An explicitly empty or malformed allowlist must remain
	// empty, otherwise a typo such as `tools: {}` silently grants bash/edit/write.
	if (value === undefined || value === null) return undefined;
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
}

const BUILTIN_AGENTS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"agents",
);

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		let parsed: ReturnType<typeof parseFrontmatter<AgentFrontmatter>>;
		try {
			parsed = parseFrontmatter<AgentFrontmatter>(content);
		} catch {
			// A single malformed YAML document must not hide every valid agent in the directory.
			continue;
		}
		const { frontmatter, body } = parsed;

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			aliases: parseToolList(frontmatter.aliases) ?? [],
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
			inheritSkills: frontmatter.inheritSkills === true,
			inheritProjectContext: frontmatter.inheritProjectContext !== false,
			suggest: frontmatter.suggest !== false,
			defaultContext:
				frontmatter.defaultContext === "fork" || frontmatter.defaultContext === "fresh"
					? frontmatter.defaultContext
					: undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const builtinAgents = loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	// Keyed case-insensitively, because lookup is: a user `recon` and a project `Recon` would
	// otherwise both survive and dispatch would silently pick whichever was discovered first.
	const put = (agent: AgentConfig) => agentMap.set(agent.name.toLowerCase(), agent);
	for (const agent of builtinAgents) put(agent);
	if (scope === "both") {
		for (const agent of userAgents) put(agent);
		for (const agent of projectAgents) put(agent);
	} else if (scope === "user") {
		for (const agent of userAgents) put(agent);
	} else {
		for (const agent of projectAgents) put(agent);
	}

	return { agents: resolveAliasCollisions(Array.from(agentMap.values())), projectAgentsDir };
}

/**
 * Drop aliases that cannot resolve to one agent.
 *
 * Agents are de-duplicated by name, so two of them may still claim the same alias, and an alias
 * may shadow another agent's real name. Either way a lookup would silently pick whichever was
 * discovered first and dispatch the wrong agent. Canonical names always win, and an alias two
 * agents claim is dropped from both: refusing to guess turns a silent mis-dispatch into an
 * ordinary "unknown agent" message that names what is available.
 */
function resolveAliasCollisions(agents: AgentConfig[]): AgentConfig[] {
	const names = new Set(agents.map((a) => a.name.toLowerCase()));
	const claims = new Map<string, number>();
	for (const agent of agents) {
		for (const alias of new Set(agent.aliases.map((a) => a.toLowerCase()))) {
			claims.set(alias, (claims.get(alias) ?? 0) + 1);
		}
	}
	return agents.map((agent) => ({
		...agent,
		aliases: agent.aliases.filter((alias) => {
			const key = alias.toLowerCase();
			return !names.has(key) && claims.get(key) === 1;
		}),
	}));
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}

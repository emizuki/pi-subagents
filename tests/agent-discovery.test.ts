import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { discoverAgents } from "../extensions/subagents/agents.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const roots: string[] = [];

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeAgent(dir: string, name: string, marker: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${name}.md`),
		`---\nname: ${name}\ndescription: ${marker}\n---\n${marker}\n`,
	);
}

function setup(): { root: string; agentDir: string; project: string; packageRoot: string } {
	// Canonicalize once, here: on macOS os.tmpdir() is itself a symlink
	// (/var/folders/... -> /private/var/folders/...), and the resolver canonicalises every
	// package root and directory it returns. Starting from a canonical root means every path this
	// fixture derives already matches what the resolver hands back, instead of only coincidentally
	// matching on platforms where os.tmpdir() happens not to involve a symlink.
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-discovery-")));
	roots.push(root);
	const agentDir = path.join(root, "agent-home");
	const project = path.join(root, "project");
	const packageRoot = path.join(root, "pi-code-review");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(packageRoot, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({
			name: "@fixture/pi-code-review",
			pi: { subagents: { agents: ["./agents"] } },
		}),
		{ flag: "w" },
	);
	return { root, agentDir, project, packageRoot };
}

test("discovers valid package agents when a sibling definition is malformed", () => {
	const { agentDir, project, packageRoot } = setup();
	const agentsDir = path.join(packageRoot, "agents");
	writeAgent(agentsDir, "audit-fixture", "package marker");
	fs.writeFileSync(path.join(agentsDir, "broken.md"), "---\nname: [unterminated\n---\nbroken\n");
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));

	const discovered = discoverAgents(project, "user").agents;
	const agent = discovered.find((candidate) => candidate.name === "audit-fixture");
	assert.ok(agent);
	assert.equal(agent.source, "package");
	assert.equal(agent.packageName, "@fixture/pi-code-review");
	assert.equal(agent.packageRoot, packageRoot);
	assert.equal(agent.packageScope, "user");
	assert.equal(agent.systemPrompt.trim(), "package marker");
	assert.equal(discovered.some((candidate) => candidate.filePath.endsWith("broken.md")), false);
});

test("applies case-insensitive builtin package user project precedence", () => {
	const { agentDir, project, packageRoot } = setup();
	writeAgent(path.join(packageRoot, "agents"), "reviewer", "package marker");
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
	const findReviewer = () => discoverAgents(project, "both").agents.find(
		(agent) => agent.name.toLowerCase() === "reviewer",
	);

	let reviewer = findReviewer();
	assert.equal(reviewer?.source, "package");
	assert.equal(reviewer?.systemPrompt.trim(), "package marker");

	writeAgent(path.join(agentDir, "agents"), "Reviewer", "user marker");
	reviewer = findReviewer();
	assert.equal(reviewer?.source, "user");
	assert.equal(reviewer?.systemPrompt.trim(), "user marker");

	writeAgent(path.join(project, ".pi", "agents"), "REVIEWER", "project marker");
	reviewer = findReviewer();
	assert.equal(reviewer?.source, "project");
	assert.equal(reviewer?.systemPrompt.trim(), "project marker");
});

test("ignores project package agents until the project is trusted", () => {
	const { project } = setup();
	const packageRoot = path.join(project, ".pi", "npm", "node_modules", "project-review");
	writeAgent(path.join(packageRoot, "agents"), "project-auditor", "trusted package marker");
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({
			name: "project-review",
			pi: { subagents: { agents: ["./agents"] } },
		}),
	);
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".pi", "settings.json"),
		JSON.stringify({ packages: ["npm:project-review"] }),
	);

	// Project package settings are read at the session cwd exactly (no ancestor walk), so the cwd
	// passed here must be the directory that owns `.pi/settings.json` itself.
	assert.equal(
		discoverAgents(project, "both", { projectTrusted: false }).agents.some(
			(agent) => agent.name === "project-auditor",
		),
		false,
	);
	const trusted = discoverAgents(project, "both", { projectTrusted: true }).agents.find(
		(agent) => agent.name === "project-auditor",
	);
	assert.equal(trusted?.source, "package");
	assert.equal(trusted?.packageScope, "project");
});

test("project package definitions replace global package definitions", () => {
	const { root, agentDir, project } = setup();
	const userPackage = path.join(root, "user-package");
	const projectPackage = path.join(root, "project-package");
	writeAgent(path.join(userPackage, "agents"), "shared-package-agent", "user package marker");
	writeAgent(path.join(projectPackage, "agents"), "shared-package-agent", "project package marker");
	for (const [packageRoot, name] of [
		[userPackage, "user-package"],
		[projectPackage, "project-package"],
	] as const) {
		fs.writeFileSync(
			path.join(packageRoot, "package.json"),
			JSON.stringify({ name, pi: { subagents: { agents: ["./agents"] } } }),
		);
	}
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [userPackage] }));
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".pi", "settings.json"),
		JSON.stringify({ packages: [projectPackage] }),
	);

	const agent = discoverAgents(project, "both", { projectTrusted: true }).agents.find(
		(candidate) => candidate.name === "shared-package-agent",
	);
	assert.equal(agent?.source, "package");
	assert.equal(agent?.packageScope, "project");
	assert.equal(agent?.systemPrompt.trim(), "project package marker");
});

test("a project-scoped package beats a same-named agent from an unrelated user-scoped package sharing its directory", () => {
	const { root, agentDir, project } = setup();
	// `sharedPackage` is configured in both scopes via the identical absolute local path, so it
	// resolves to the same canonical directory either way; `otherUserPackage` is a distinct,
	// purely user-scoped package that happens to define an agent with the same name.
	const sharedPackage = path.join(root, "shared-package");
	const otherUserPackage = path.join(root, "other-user-package");
	writeAgent(path.join(sharedPackage, "agents"), "collision-agent", "project version");
	writeAgent(path.join(otherUserPackage, "agents"), "collision-agent", "user version");
	for (const [packageRoot, name] of [
		[sharedPackage, "shared-package"],
		[otherUserPackage, "other-user-package"],
	] as const) {
		fs.writeFileSync(
			path.join(packageRoot, "package.json"),
			JSON.stringify({ name, pi: { subagents: { agents: ["./agents"] } } }),
		);
	}
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ packages: [sharedPackage, otherUserPackage] }),
	);
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ packages: [sharedPackage] }));

	const agent = discoverAgents(project, "both", { projectTrusted: true }).agents.find(
		(candidate) => candidate.name === "collision-agent",
	);
	assert.equal(agent?.packageScope, "project");
	assert.equal(agent?.systemPrompt.trim(), "project version");
});

test("coordinator frontmatter parses the nested fields", () => {
	const { root, agentDir } = setup();
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(agentDir, "agents", "boss.md"),
		"---\nname: boss\ndescription: d\nallowNestedSubagents: true\nallowedSubagents: recon, scout\n---\nBody\n",
	);
	const boss = discoverAgents(root, "user").agents.find((a) => a.name === "boss");
	assert.ok(boss);
	assert.equal(boss.allowNestedSubagents, true);
	assert.deepEqual(boss.allowedSubagents, ["recon", "scout"]);
});

test("nested fields default off and grant nothing when not exactly true", () => {
	const { root, agentDir } = setup();
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "agents", "plain.md"), "---\nname: plain\ndescription: d\n---\nBody\n");
	fs.writeFileSync(
		path.join(agentDir, "agents", "truthy.md"),
		'---\nname: truthy\ndescription: d\nallowNestedSubagents: "yes"\nallowedSubagents: recon\n---\nBody\n',
	);
	const agents = discoverAgents(root, "user").agents;
	const plain = agents.find((a) => a.name === "plain");
	const truthy = agents.find((a) => a.name === "truthy");
	assert.ok(plain && truthy);
	assert.equal(plain.allowNestedSubagents, false);
	assert.deepEqual(plain.allowedSubagents, []);
	// A string is not the boolean true. Granting on truthiness would let `allowNestedSubagents: "no"` grant.
	assert.equal(truthy.allowNestedSubagents, false);
});
